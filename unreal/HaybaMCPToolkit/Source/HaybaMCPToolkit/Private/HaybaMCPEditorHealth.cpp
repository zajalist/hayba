#include "HaybaMCPEditorHealth.h"

#include "Containers/Ticker.h"
#include "CoreGlobals.h"
#include "Framework/Notifications/NotificationManager.h"
#include "IPythonScriptPlugin.h"
#include "Misc/App.h"
#include "Misc/AssertionMacros.h"
#include "Misc/DateTime.h"
#include "UObject/UObjectGlobals.h"
#include "Widgets/Notifications/SNotificationList.h"
#include <atomic>

DEFINE_LOG_CATEGORY(LogHaybaMCPHealth);

#define LOCTEXT_NAMESPACE "HaybaMCPHealth"

struct FHaybaEditorHealth::FState
{
	std::atomic<bool> bUnsafe{ false };
	std::atomic<bool> bPythonUnhealthy{ false };
	std::atomic<uint64> FaultSequence{ 0 };
	FSnapshot Record;
	HaybaMCPHealth::ECause GateCause = HaybaMCPHealth::ECause::None;
	FTSTicker::FDelegateHandle PendingNotification;
	bool bNotificationScheduled = false;
	bool bGcUnhooked = false;
	/** Set only by FScopedOverrideForTests: its notification goes to the counters below. */
	bool bTestOverride = false;
	// Test-override counters (cheap enough to keep in every build).
	int32 NotificationCount = 0;
	FString LastNotificationText;
	int32 PreGcUnhookCount = 0;
	int32 FaultErrorLineCount = 0;
};

FHaybaEditorHealth::FState* FHaybaEditorHealth::ActiveOverride = nullptr;

namespace
{
	constexpr int32 MaxNoteChars = 128;
	constexpr int32 MaxEngineErrorChars = 512;

	FHaybaEditorHealth::FScopedDispatchNote* GCurrentDispatchNote = nullptr;
	TWeakPtr<SNotificationItem> GUnsafeNotification;

	FString FirstLine(const TCHAR* Text)
	{
		FString Line(Text);
		int32 NewLine = INDEX_NONE;
		if (Line.FindChar(TEXT('\n'), NewLine)) Line.LeftInline(NewLine);
		Line.TrimEndInline();
		return Line.Left(MaxEngineErrorChars);
	}

	void DismissUnsafeNotification()
	{
		if (const TSharedPtr<SNotificationItem> Item = GUnsafeNotification.Pin())
		{
			Item->SetCompletionState(SNotificationItem::CS_None);
			Item->ExpireAndFadeout();
		}
		GUnsafeNotification.Reset();
	}
}

FHaybaEditorHealth::FState& FHaybaEditorHealth::Active()
{
	// Leaked on purpose, like the batch state: it must outlive static destruction.
	static FState* Real = new FState();
	return ActiveOverride ? *ActiveOverride : *Real;
}

bool FHaybaEditorHealth::IsUnsafe() { return Active().bUnsafe.load(); }
bool FHaybaEditorHealth::IsPythonUnhealthy() { return Active().bPythonUnhealthy.load(); }
uint64 FHaybaEditorHealth::FaultSequence() { return Active().FaultSequence.load(); }
HaybaMCPHealth::ECause FHaybaEditorHealth::GateCause() { return Active().GateCause; }
void FHaybaEditorHealth::NoteRefusal() { ++Active().Record.RefusedCount; }

void FHaybaEditorHealth::RecordCaughtFault(EHaybaFaultSite Site, uint32 ExceptionCode, bool bWorldSwitchRepaired)
{
	RecordFault(Site, ExceptionCode, bWorldSwitchRepaired, FString());
}

void FHaybaEditorHealth::RecordPythonCorruption(const FString& MatchedMarker)
{
	RecordFault(EHaybaFaultSite::Python, 0, false, MatchedMarker);
}

void FHaybaEditorHealth::RecordFault(EHaybaFaultSite Site, uint32 ExceptionCode, bool bWorldSwitchRepaired, const FString& Marker)
{
	using namespace HaybaMCPHealth;
	FState& S = Active();

	// 1. Flip the atomics first: anything that reads health after this line sees unsafe.
	S.bUnsafe.store(true);
	if (Site == EHaybaFaultSite::Python) S.bPythonUnhealthy.store(true);
	S.FaultSequence.fetch_add(1);

	// 2. Engine facts, gathered in ordinary code after the guard returned.
	const bool bCriticalError = GIsCriticalError;
	const bool bSavingPackage = UE::IsSavingPackage(nullptr);
	const bool bHasAsserted = FDebug::HasAsserted();
	const ECause Cause = ClassifyCaughtFault(Site, ExceptionCode, bCriticalError, bSavingPackage);
	S.GateCause = MoreSevere(S.GateCause, Cause);

	// 3. The dispatch note, clipped. The record keeps the FIRST fault.
	const FScopedDispatchNote* Note = GCurrentDispatchNote;
	const FString Cmd = Note ? Note->Cmd->Left(MaxNoteChars) : FString(TEXT("<no dispatch>"));
	const FString Id = Note ? Note->Id->Left(MaxNoteChars) : FString();
	const FString Owner = Note ? Note->Owner->Left(MaxNoteChars) : FString();
	FSnapshot& R = S.Record;
	if (R.FaultCount == 0)
	{
		R.Cause = Cause;
		R.Site = Site;
		R.ExceptionCode = ExceptionCode;
		R.FaultFrame = GFrameCounter;
		R.FaultCode = FaultCodeFor(Cause);
		R.FaultedCommand = Cmd;
		R.FaultedRequestId = Id;
		R.FaultedOwner = Owner;
		R.FaultedAtUtc = FDateTime::UtcNow().ToString(TEXT("%Y-%m-%dT%H:%M:%SZ"));
		R.bCriticalError = bCriticalError;
		R.bSavingPackageStranded = bSavingPackage;
		R.bWorldSwitchRepaired = bWorldSwitchRepaired;
		R.bHasAsserted = bHasAsserted;
		R.EngineErrorFirstLine = FirstLine(GErrorHist);
	}
	++R.FaultCount;
	R.LastCause = Cause;
	R.LastSite = Site;
	R.LastExceptionCode = ExceptionCode;

	// 4. One Error line per fault.
	++S.FaultErrorLineCount;
	UE_LOG(LogHaybaMCPHealth, Error, TEXT("%s"),
		*FormatFaultLine(Cause, ExceptionCode, Cmd, Id, Owner, Site, GFrameCounter, Marker));

	// 5. python_native_fault only: stop every later GC from running gc.collect in
	//    the damaged interpreter. Buys time, not survival (ADR-0011).
	if (Cause == ECause::PythonNativeFault && !S.bGcUnhooked)
	{
		S.bGcUnhooked = true;
		if (ActiveOverride)
		{
			++S.PreGcUnhookCount;
		}
		else if (IPythonScriptPlugin* Python = IPythonScriptPlugin::Get())
		{
			// The engine binds AddRaw(this, &FPythonScriptPlugin::OnPreGarbageCollect), and
			// IPythonScriptPlugin is FPythonScriptPlugin's first base: the pointer matches.
			FCoreUObjectDelegates::GetPreGarbageCollectDelegate().RemoveAll(Python);
		}
		UE_LOG(LogHaybaMCPHealth, Warning,
			TEXT("editor_unsafe: Python unhooked from the pre-GC delegate after a contained Python fault; garbage collection no longer runs gc.collect in the damaged interpreter. This buys time, not safety: save and restart the editor."));
	}

	// 6. First fault only: tell the person at the editor on the next tick, never from this stack.
	if (!S.bNotificationScheduled)
	{
		S.bNotificationScheduled = true;
		S.PendingNotification = FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateStatic(&FHaybaEditorHealth::DeliverUserNotification, &S), 0.0f);
	}
}

bool FHaybaEditorHealth::DeliverUserNotification(float /*DeltaSeconds*/, FState* State)
{
	using namespace HaybaMCPHealth;
	FState& S = *State;
	S.PendingNotification.Reset();
	const ECause Cause = S.Record.Cause;
	const FString Text = NotificationTextFor(Cause, S.Record.FaultedCommand);

	const TCHAR* Channel = TEXT("notification");
	if (S.bTestOverride)
	{
		// R-4: the test seam comes BEFORE the unattended skip, so headless runs reach it.
		++S.NotificationCount;
		S.LastNotificationText = Text;
		Channel = TEXT("test_counter");
	}
	else if (FApp::IsUnattended() || IsRunningCommandlet())
	{
		Channel = TEXT("log_only");
	}
	else
	{
		FNotificationInfo Info(FText::FromString(Text));
		Info.bFireAndForget = false;
		Info.ExpireDuration = 0.0f;
		Info.bUseSuccessFailIcons = true;
		Info.ButtonDetails.Add(FNotificationButtonInfo(
			LOCTEXT("Dismiss", "Dismiss"),
			LOCTEXT("DismissTip", "Hide this message. The editor stays unsafe until it restarts."),
			FSimpleDelegate::CreateStatic(&DismissUnsafeNotification),
			SNotificationItem::CS_Fail));
		if (const TSharedPtr<SNotificationItem> Item = FSlateNotificationManager::Get().AddNotification(Info))
		{
			Item->SetCompletionState(SNotificationItem::CS_Fail);
			GUnsafeNotification = Item;
		}
	}
	// M8: the frame here is at most one after the fault frame.
	UE_LOG(LogHaybaMCPHealth, Log, TEXT("editor_unsafe: user notified (cause %s, frame %llu) via %s"),
		LexCause(Cause), static_cast<unsigned long long>(GFrameCounter), Channel);
	return false;   // one-shot
}

FHaybaEditorHealth::FSnapshot FHaybaEditorHealth::Snapshot()
{
	const FState& S = Active();
	FSnapshot Out = S.Record;
	Out.bUnsafe = S.bUnsafe.load();
	Out.bPythonUnhealthy = S.bPythonUnhealthy.load();
	Out.GateCause = S.GateCause;
	return Out;
}

TSharedRef<FJsonObject> FHaybaEditorHealth::MakeHealthJson()
{
	using namespace HaybaMCPHealth;
	const FSnapshot H = Snapshot();
	const bool bFaulted = H.FaultCount > 0;
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetBoolField(TEXT("editor_unsafe"), H.bUnsafe);
	Json->SetBoolField(TEXT("python_unhealthy"), H.bPythonUnhealthy);
	Json->SetBoolField(TEXT("restart_required"), H.bUnsafe);
	Json->SetStringField(TEXT("cause"), LexCause(H.Cause));
	Json->SetStringField(TEXT("fault_code"), H.FaultCode);
	Json->SetStringField(TEXT("site"), bFaulted ? LexSite(H.Site) : TEXT(""));
	Json->SetStringField(TEXT("exception_code"), bFaulted ? FString::Printf(TEXT("0x%08X"), H.ExceptionCode) : FString());
	Json->SetStringField(TEXT("faulted_command"), H.FaultedCommand);
	Json->SetStringField(TEXT("faulted_request_id"), H.FaultedRequestId);
	Json->SetStringField(TEXT("faulted_owner"), H.FaultedOwner);
	Json->SetStringField(TEXT("faulted_at_utc"), H.FaultedAtUtc);
	Json->SetNumberField(TEXT("fault_count"), H.FaultCount);
	Json->SetNumberField(TEXT("refused_count"), H.RefusedCount);
	Json->SetBoolField(TEXT("critical_error"), H.bCriticalError);
	Json->SetBoolField(TEXT("saving_package_stranded"), H.bSavingPackageStranded);
	Json->SetBoolField(TEXT("world_switch_repaired"), H.bWorldSwitchRepaired);
	return Json;
}

void FHaybaEditorHealth::WriteJson(const TSharedRef<FJsonObject>& Out)
{
	Out->SetBoolField(TEXT("editor_unsafe"), IsUnsafe());
	Out->SetBoolField(TEXT("python_unhealthy"), IsPythonUnhealthy());
	Out->SetObjectField(TEXT("health"), MakeHealthJson());
}

void FHaybaEditorHealth::RevokeCallbacks()
{
	FState& S = Active();
	if (S.PendingNotification.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(S.PendingNotification);
		S.PendingNotification.Reset();
	}
	DismissUnsafeNotification();
}

FHaybaEditorHealth::FScopedDispatchNote::FScopedDispatchNote(const FString& InCmd, const FString& InId, const FString& InOwner)
	: Cmd(&InCmd), Id(&InId), Owner(&InOwner), Previous(GCurrentDispatchNote)
{
	GCurrentDispatchNote = this;
}

FHaybaEditorHealth::FScopedDispatchNote::~FScopedDispatchNote()
{
	GCurrentDispatchNote = Previous;
}

#if WITH_DEV_AUTOMATION_TESTS
FHaybaEditorHealth::FScopedOverrideForTests::FScopedOverrideForTests()
	: Owned(new FState())
	, Previous(FHaybaEditorHealth::ActiveOverride)
{
	Owned->bTestOverride = true;
	FHaybaEditorHealth::ActiveOverride = Owned;
}

FHaybaEditorHealth::FScopedOverrideForTests::~FScopedOverrideForTests()
{
	// A notification scheduled against this state must never fire against the real one.
	if (Owned->PendingNotification.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(Owned->PendingNotification);
	}
	FHaybaEditorHealth::ActiveOverride = Previous;
	delete Owned;
}

int32 FHaybaEditorHealth::FScopedOverrideForTests::NotificationCount() const { return Owned->NotificationCount; }
FString FHaybaEditorHealth::FScopedOverrideForTests::LastNotificationText() const { return Owned->LastNotificationText; }
int32 FHaybaEditorHealth::FScopedOverrideForTests::PreGcUnhookCount() const { return Owned->PreGcUnhookCount; }
int32 FHaybaEditorHealth::FScopedOverrideForTests::FaultErrorLineCount() const { return Owned->FaultErrorLineCount; }

bool FHaybaEditorHealth::FScopedOverrideForTests::FlushPendingNotification()
{
	if (!Owned->PendingNotification.IsValid()) return false;
	FTSTicker::GetCoreTicker().RemoveTicker(Owned->PendingNotification);
	FHaybaEditorHealth::DeliverUserNotification(0.0f, Owned);
	return true;
}

bool FHaybaEditorHealth::IsTestOverrideActive()
{
	return ActiveOverride != nullptr;
}
#endif

#undef LOCTEXT_NAMESPACE
