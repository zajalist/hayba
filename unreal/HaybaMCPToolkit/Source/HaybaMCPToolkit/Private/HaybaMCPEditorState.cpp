// HaybaMCPEditorState.cpp - see header.

#include "HaybaMCPEditorState.h"

#include "HaybaMCPEditorHealth.h"
#include "HaybaMCPLeaseManager.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Features/IModularFeatures.h"
#include "Framework/Notifications/NotificationManager.h"
#include "HAL/PlatformTime.h"
#include "IPIEAuthorizer.h"
#include "Misc/EngineVersionComparison.h"
#include "Templates/ValueOrError.h"
#include "Widgets/Notifications/SNotificationList.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPState, Log, All);

/**
 * Vetoes the user's Play button while the editor is unsafe (D2). It never
 * greys the button out, and it never cancels the request itself: the engine
 * cancels a denied request (PlayLevel.cpp:2616-2632), and a second cancel from
 * here would broadcast CancelPIE twice and reset the request while the engine
 * still holds a reference into it (PlayLevel.cpp:1197).
 */
class FHaybaPIEAuthorizer final : public IPIEAuthorizer
{
#if UE_VERSION_OLDER_THAN(5, 8, 0)
public:
	// UE 5.7: compiled behind this guard and unverified (the toolkit does not build on 5.7 today).
	virtual bool RequestPIEPermission(bool /*bIsSimulateInEditor*/, FString& OutReason) const override
	{
		const HaybaMCPState::FPlayDecision Decision = FHaybaMCPEditorState::Get().EvaluateUserPlayRequest(FPlatformTime::Seconds());
		if (!Decision.bDeny)
		{
			return true;
		}
		OutReason = Decision.Reason;
		UE_LOG(LogHaybaMCPState, Warning, TEXT("Play vetoed: %s"), *Decision.Reason);
		// 5.7's authorizer loop posts nothing itself, so Hayba does.
		FSlateNotificationManager::Get().AddNotification(FNotificationInfo(FText::FromString(Decision.Reason)));
		return false;
	}
#else
protected:
	virtual TValueOrError<bool, FText> IsPIEAuthorizedInternal(bool /*bIsSimulateInEditor*/) const override
	{
		return MakeValue(true);
	}

	virtual TValueOrError<bool, FText> RequestPIEPermissionInternal(bool /*bIsSimulateInEditor*/) const override
	{
		const HaybaMCPState::FPlayDecision Decision = FHaybaMCPEditorState::Get().EvaluateUserPlayRequest(FPlatformTime::Seconds());
		if (!Decision.bDeny)
		{
			return MakeValue(true);
		}
		UE_LOG(LogHaybaMCPState, Warning, TEXT("Play vetoed: %s"), *Decision.Reason);
		return MakeError(FText::FromString(Decision.Reason));
	}
#endif
};

namespace
{
	FHaybaPIEAuthorizer& PlayAuthorizer()
	{
		static FHaybaPIEAuthorizer Instance;
		return Instance;
	}
}

FHaybaMCPEditorState& FHaybaMCPEditorState::Get()
{
	static FHaybaMCPEditorState Instance;
	return Instance;
}

void FHaybaMCPEditorState::Startup()
{
	if (bStarted)
	{
		return;
	}
	bStarted = true;

	PreBeginHandle = FEditorDelegates::PreBeginPIE.AddLambda([](const bool bIsSimulating)
	{
		FHaybaMCPEditorState::Get().Tracker.OnPreBegin(bIsSimulating, FPlatformTime::Seconds());
	});
	BeginHandle = FEditorDelegates::BeginPIE.AddLambda([](const bool bIsSimulating)
	{
		FHaybaMCPEditorState::Get().Tracker.OnBegin(bIsSimulating, FPlatformTime::Seconds());
	});
	EndHandle = FEditorDelegates::EndPIE.AddLambda([](const bool)
	{
		FHaybaMCPEditorState::Get().Tracker.OnEnd(FPlatformTime::Seconds());
	});
	ShutdownHandle = FEditorDelegates::ShutdownPIE.AddLambda([](const bool)
	{
		FHaybaMCPEditorState::Get().Tracker.OnEnd(FPlatformTime::Seconds());
	});
	CancelHandle = FEditorDelegates::CancelPIE.AddLambda([]()
	{
		FHaybaMCPEditorState::Get().Tracker.OnEnd(FPlatformTime::Seconds());
	});
	SwitchHandle = FEditorDelegates::OnSwitchBeginPIEAndSIE.AddLambda([](const bool bIsSimulating)
	{
		FHaybaMCPEditorState::Get().Tracker.OnSwitchSimulate(bIsSimulating);
	});

	// Loaded during a session (a module reload while playing): it is the user's.
	if (GEditor && GEditor->PlayWorld)
	{
		Tracker.OnBegin(GEditor->IsSimulatingInEditor(), FPlatformTime::Seconds());
	}

	IModularFeatures::Get().RegisterModularFeature(IPIEAuthorizer::GetModularFeatureName(), &PlayAuthorizer());
	UE_LOG(LogHaybaMCPState, Log, TEXT("editor state: PIE hooks bound, Play authorizer registered"));
}

void FHaybaMCPEditorState::Shutdown()
{
	if (!bStarted)
	{
		return;
	}
	bStarted = false;
	FEditorDelegates::PreBeginPIE.Remove(PreBeginHandle);
	FEditorDelegates::BeginPIE.Remove(BeginHandle);
	FEditorDelegates::EndPIE.Remove(EndHandle);
	FEditorDelegates::ShutdownPIE.Remove(ShutdownHandle);
	FEditorDelegates::CancelPIE.Remove(CancelHandle);
	FEditorDelegates::OnSwitchBeginPIEAndSIE.Remove(SwitchHandle);
	PreBeginHandle.Reset();
	BeginHandle.Reset();
	EndHandle.Reset();
	ShutdownHandle.Reset();
	CancelHandle.Reset();
	SwitchHandle.Reset();
	IModularFeatures::Get().UnregisterModularFeature(IPIEAuthorizer::GetModularFeatureName(), &PlayAuthorizer());
}

bool FHaybaMCPEditorState::AreHooksBound() const
{
	return bStarted && PreBeginHandle.IsValid() && BeginHandle.IsValid() && EndHandle.IsValid()
		&& ShutdownHandle.IsValid() && CancelHandle.IsValid() && SwitchHandle.IsValid();
}

bool FHaybaMCPEditorState::IsAuthorizerRegistered() const
{
	const TArray<IPIEAuthorizer*> Registered =
		IModularFeatures::Get().GetModularFeatureImplementations<IPIEAuthorizer>(IPIEAuthorizer::GetModularFeatureName());
	return Registered.Contains(static_cast<IPIEAuthorizer*>(&PlayAuthorizer()));
}

void FHaybaMCPEditorState::NoteAgentPieRequest(const FString& Owner)
{
	Tracker.NoteAgentRequest(Owner, FPlatformTime::Seconds());
}

HaybaMCPState::FPieState FHaybaMCPEditorState::CurrentPie() const
{
#if WITH_DEV_AUTOMATION_TESTS
	if (PieOverride.IsSet())
	{
		return PieOverride.GetValue();
	}
#endif
	const bool bPlayWorld = GEditor && GEditor->PlayWorld != nullptr;
	const bool bRequestQueued = GEditor && GEditor->IsPlaySessionRequestQueued();
	return HaybaMCPState::ResolvePie(Tracker, bPlayWorld, bRequestQueued, FPlatformTime::Seconds());
}

bool FHaybaMCPEditorState::IsPieActiveOrQueued() const
{
	return CurrentPie().Kind != HaybaMCPState::EPieKind::None;
}

void FHaybaMCPEditorState::WritePieJson(const TSharedRef<FJsonObject>& Out) const
{
	const HaybaMCPState::FPieState Pie = CurrentPie();
	const bool bActive = Pie.Kind != HaybaMCPState::EPieKind::None;
	Out->SetStringField(TEXT("pie"), HaybaMCPState::LexPie(Pie));
	Out->SetBoolField(TEXT("pie_running"), bActive);
	Out->SetStringField(TEXT("pie_phase"), HaybaMCPState::LexPiePhase(Pie.Phase));
	Out->SetNumberField(TEXT("pie_since_s"), bActive ? FMath::Max(0.0, FPlatformTime::Seconds() - Pie.Since) : 0.0);
	Out->SetBoolField(TEXT("pie_simulating"), Pie.bSimulating);
}

TArray<HaybaMCPState::FBusyAsset> FHaybaMCPEditorState::BuildingAssets() const
{
	// FindAssetHolders expires first. Its lease pointers are copied before any
	// other table call can move them.
	HaybaMCPLease::FTable& Table = FHaybaMCPLeaseManager::Get().Table();
	return HaybaMCPState::MakeBusyAssets(Table.FindAssetHolders(FString()), FHaybaMCPLeaseManager::Get().Now(), FDateTime::UtcNow());
}

TArray<HaybaMCPState::FBusyAsset> FHaybaMCPEditorState::BusyAssetsFor(const TArray<FString>& AssetKeys, const FString& ExcludeOwner) const
{
	HaybaMCPLease::FTable& Table = FHaybaMCPLeaseManager::Get().Table();
	TArray<HaybaMCPState::FBusyAsset> Out;
	for (const FString& Key : AssetKeys)
	{
		Out.Append(HaybaMCPState::MakeBusyAssets(Table.FindAssetHolders(ExcludeOwner, Key), FHaybaMCPLeaseManager::Get().Now(), FDateTime::UtcNow()));
	}
	return Out;
}

void FHaybaMCPEditorState::WriteBuildingJson(const TSharedRef<FJsonObject>& Out) const
{
	Out->SetArrayField(TEXT("building"), HaybaMCPState::BusyAssetsToJson(BuildingAssets()));
}

HaybaMCPState::FPlayDecision FHaybaMCPEditorState::EvaluateUserPlayRequest(double Now)
{
	const HaybaMCPState::FPieState Pie = CurrentPie();
	const HaybaMCPState::EPlayRequestKind Kind = Pie.Kind == HaybaMCPState::EPieKind::Agent
		? HaybaMCPState::EPlayRequestKind::Agent
		: HaybaMCPState::EPlayRequestKind::User;
	// T10 supplies the build leases, the hayba.PIEBuildVeto mode and the last veto time.
	return HaybaMCPState::DecideUserPlay(TArray<HaybaMCPState::FBusyAsset>(), Kind, /*Mode=*/1,
		FHaybaEditorHealth::IsUnsafe(), /*LastVetoAt=*/-1.0, Now);
}

#if WITH_DEV_AUTOMATION_TESTS
FHaybaMCPEditorState::FScopedPieOverride::FScopedPieOverride(const HaybaMCPState::FPieState& Forced)
	: Previous(FHaybaMCPEditorState::Get().PieOverride)
{
	FHaybaMCPEditorState::Get().PieOverride = Forced;
}

FHaybaMCPEditorState::FScopedPieOverride::~FScopedPieOverride()
{
	FHaybaMCPEditorState::Get().PieOverride = Previous;
}
#endif
