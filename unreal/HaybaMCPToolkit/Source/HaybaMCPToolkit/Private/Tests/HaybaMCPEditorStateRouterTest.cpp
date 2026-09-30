#include "Misc/AutomationTest.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPEditorState.h"
#include "HaybaMCPEditorStatePolicy.h"
#include "HaybaMCPLeaseManager.h"
#include "HaybaMCPModule.h"
#include "HaybaMCPSettings.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Editor/EditorEngine.h"
#include "Features/IModularFeatures.h"
#include "GameFramework/Actor.h"
#include "IPIEAuthorizer.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/Guid.h"
#include "Misc/ScopeExit.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"

#if WITH_DEV_AUTOMATION_TESTS

// Router and runtime Hayba.MCP.State.* tests (docs/adr/0012). Router tests go
// through ProcessCommand so every reply passes JsonToString and the redactor.
// Unique owners (hayba-test-<guid8>), ConnIds >= 900000, assets under
// /Game/__HaybaTest__/. A real PIE is never started here except by
// Hayba.MCP.State.RealPIE (opt-in, owned child).

namespace HaybaMCPStateTest
{
	TSharedPtr<FHaybaMCPCommandHandler> GetRouter(FAutomationTestBase& Test)
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		if (!Test.TestNotNull(TEXT("toolkit module is loaded"), Module))
		{
			return nullptr;
		}
		const TSharedPtr<FHaybaMCPCommandHandler> Router = Module->GetCommandHandler();
		Test.TestTrue(TEXT("command router exists"), Router.IsValid());
		return Router;
	}

	FString MakeTestOwner()
	{
		return TEXT("hayba-test-") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	}

	HaybaMCPState::FPieState MakePie(HaybaMCPState::EPieKind Kind, HaybaMCPState::EPiePhase Phase, const FString& Owner = FString())
	{
		HaybaMCPState::FPieState S;
		S.Kind = Kind;
		S.Phase = Phase;
		S.Owner = Owner;
		S.Since = FPlatformTime::Seconds();
		return S;
	}

	TSharedPtr<FJsonObject> Send(FHaybaMCPCommandHandler& Router, int32 ConnId, const FString& Owner,
		const FString& Cmd, const TSharedPtr<FJsonObject>& Params = nullptr)
	{
		static int32 Sequence = 0;
		TSharedRef<FJsonObject> Envelope = MakeShared<FJsonObject>();
		Envelope->SetStringField(TEXT("id"), FString::Printf(TEXT("state-test-%d"), ++Sequence));
		Envelope->SetStringField(TEXT("cmd"), Cmd);
		if (!Owner.IsEmpty())
		{
			Envelope->SetStringField(TEXT("owner"), Owner);
		}
		const FString& Auth = FHaybaMCPSettings::Get().CapabilityToken;
		if (!Auth.IsEmpty())
		{
			Envelope->SetStringField(TEXT("auth"), Auth);
		}
		Envelope->SetObjectField(TEXT("params"), Params.IsValid() ? Params.ToSharedRef() : MakeShared<FJsonObject>());
		FString Request;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Request);
		FJsonSerializer::Serialize(Envelope, Writer);
		TSharedPtr<FJsonObject> Reply;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Router.ProcessCommand(Request, ConnId));
		FJsonSerializer::Deserialize(Reader, Reply);
		return Reply;
	}

	FString StringOf(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		FString Value;
		if (Obj.IsValid()) Obj->TryGetStringField(Field, Value);
		return Value;
	}

	bool BoolOf(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		bool bValue = false;
		if (Obj.IsValid()) Obj->TryGetBoolField(Field, bValue);
		return bValue;
	}

	double NumberOf(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		double Value = -1.0;
		if (Obj.IsValid()) Obj->TryGetNumberField(Field, Value);
		return Value;
	}

	TSharedPtr<FJsonObject> ObjectOf(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		const TSharedPtr<FJsonObject>* Value = nullptr;
		return (Obj.IsValid() && Obj->TryGetObjectField(Field, Value) && Value) ? *Value : nullptr;
	}

	FString CodeOf(const TSharedPtr<FJsonObject>& Reply)
	{
		return StringOf(Reply, TEXT("code"));
	}

	bool NoRealPie(FAutomationTestBase& Test)
	{
		return Test.TestFalse(TEXT("precondition: no real PIE session or queued request"),
			GEditor && (GEditor->PlayWorld != nullptr || GEditor->IsPlaySessionRequestQueued()));
	}

	/** Safety net: a failing assertion must never leave a real PIE queued for the next tick. */
	void CancelQueuedPie()
	{
		if (GEditor && !GEditor->PlayWorld && GEditor->IsPlaySessionRequestQueued())
		{
			GEditor->CancelRequestPlaySession();
		}
	}
}

using namespace HaybaMCPStateTest;

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateHooksBoundAtStartupTest,
	"Hayba.MCP.State.HooksBoundAtStartup",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateHooksBoundAtStartupTest::RunTest(const FString& Parameters)
{
	// The headless run passes -HaybaAutomationChild, which skips the TCP server,
	// so this also proves Startup() does not depend on it (R-14).
	FHaybaMCPEditorState& State = FHaybaMCPEditorState::Get();
	TestTrue(TEXT("PIE hooks are bound at module startup"), State.AreHooksBound());
	TestTrue(TEXT("the Play authorizer is registered at module startup"), State.IsAuthorizerRegistered());

	const int32 RegisteredBefore = IModularFeatures::Get().GetModularFeatureImplementationCount(IPIEAuthorizer::GetModularFeatureName());
	TestTrue(TEXT("at least our authorizer is registered"), RegisteredBefore >= 1);
	State.Startup();   // idempotent
	TestEqual(TEXT("a second Startup registers nothing more"),
		IModularFeatures::Get().GetModularFeatureImplementationCount(IPIEAuthorizer::GetModularFeatureName()), RegisteredBefore);
	TestTrue(TEXT("and stays registered"), State.IsAuthorizerRegistered());

	// The test seam that later router tests rely on.
	{
		FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::Agent, HaybaMCPState::EPiePhase::Running, TEXT("lane-a")));
		TestTrue(TEXT("an override makes PIE active"), State.IsPieActiveOrQueued());
		const TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
		State.WritePieJson(Out);
		TestEqual(TEXT("pie"), StringOf(Out, TEXT("pie")), FString(TEXT("agent:lane-a")));
		TestEqual(TEXT("pie_phase"), StringOf(Out, TEXT("pie_phase")), FString(TEXT("running")));
		TestTrue(TEXT("pie_running derives from the resolved state"), BoolOf(Out, TEXT("pie_running")));
		TestTrue(TEXT("pie_since_s is present"), Out->HasField(TEXT("pie_since_s")));
		TestTrue(TEXT("pie_simulating is present"), Out->HasField(TEXT("pie_simulating")));
	}
	if (NoRealPie(*this))
	{
		TestFalse(TEXT("the override is gone after its scope"), State.IsPieActiveOrQueued());
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRouterRefusesMutationDuringPIETest,
	"Hayba.MCP.State.RouterRefusesMutationDuringPIE",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRouterRefusesMutationDuringPIETest::RunTest(const FString& Parameters)
{
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;
	ON_SCOPE_EXIT { CancelQueuedPie(); };

	FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::User, HaybaMCPState::EPiePhase::Running));
	// The owner contains "seh": a router refusal must never be classified by its words.
	const FString Owner = TEXT("Joseh-") + MakeTestOwner();

	for (const TCHAR* Cmd : { TEXT("blueprint_add_node"), TEXT("editor_start_pie"), TEXT("python_run"), TEXT("editor_stop_pie"), TEXT("editor_batch") })
	{
		AddExpectedMessagePlain(FString::Printf(TEXT("pie_active: refused '%s' from '%s'"), Cmd, *Owner),
			ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	}

	TSharedPtr<FJsonObject> AddNode = MakeShared<FJsonObject>();
	AddNode->SetStringField(TEXT("path"), TEXT("/Game/__HaybaTest__/BP_PieGate"));
	for (int32 Attempt = 0; Attempt < 2; ++Attempt)   // twice: the limiter logs the Warning once
	{
		const TSharedPtr<FJsonObject> Reply = Send(*Router, 900101, Owner, TEXT("blueprint_add_node"), AddNode);
		TestFalse(TEXT("blueprint_add_node is refused"), BoolOf(Reply, TEXT("ok")));
		TestEqual(TEXT("with pie_active"), CodeOf(Reply), FString(TEXT("pie_active")));
		TestTrue(TEXT("the error says nothing ran"), StringOf(Reply, TEXT("error")).StartsWith(TEXT("pie_active: 'blueprint_add_node' was not run")));
		TestFalse(TEXT("no refusal text says token"), StringOf(Reply, TEXT("error")).Contains(TEXT("token"), ESearchCase::IgnoreCase));
		const TSharedPtr<FJsonObject> Advisory = ObjectOf(Reply, TEXT("advisory"));
		TestEqual(TEXT("retryable"), StringOf(Advisory, TEXT("state")), FString(TEXT("retryable_failure")));
		TestEqual(TEXT("nothing started"), StringOf(Advisory, TEXT("mutation_status")), FString(TEXT("not_started")));
		TestEqual(TEXT("'Joseh' does not make the session suspect"), StringOf(Advisory, TEXT("session_health")), FString(TEXT("healthy")));
		const TSharedPtr<FJsonObject> Pie = ObjectOf(Reply, TEXT("pie"));
		TestEqual(TEXT("detail: pie"), StringOf(Pie, TEXT("pie")), FString(TEXT("user")));
		TestEqual(TEXT("detail: phase"), StringOf(Pie, TEXT("phase")), FString(TEXT("running")));
		TestEqual(TEXT("detail: command"), StringOf(Pie, TEXT("command")), FString(TEXT("blueprint_add_node")));
		TestEqual(TEXT("detail: caller_owner"), StringOf(Pie, TEXT("caller_owner")), Owner);
		TestEqual(TEXT("detail: rule"), StringOf(Pie, TEXT("rule")), FString(TEXT("refuse")));
		TestTrue(TEXT("detail: simulating"), Pie.IsValid() && Pie->HasField(TEXT("simulating")));
		TestTrue(TEXT("detail: since_s"), Pie.IsValid() && Pie->HasField(TEXT("since_s")));
	}

	TSharedPtr<FJsonObject> Script = MakeShared<FJsonObject>();
	Script->SetStringField(TEXT("script"), TEXT("print(1)"));
	TestEqual(TEXT("editor_start_pie is refused"), CodeOf(Send(*Router, 900101, Owner, TEXT("editor_start_pie"))), FString(TEXT("pie_active")));
	TestEqual(TEXT("python_run is refused"), CodeOf(Send(*Router, 900101, Owner, TEXT("python_run"), Script)), FString(TEXT("pie_active")));
	TestEqual(TEXT("editor_batch is refused"), CodeOf(Send(*Router, 900101, Owner, TEXT("editor_batch"))), FString(TEXT("pie_active")));
	const TSharedPtr<FJsonObject> UserStop = Send(*Router, 900101, Owner, TEXT("editor_stop_pie"));
	TestEqual(TEXT("nobody stops the user's PIE"), CodeOf(UserStop), FString(TEXT("pie_active")));
	TestEqual(TEXT("under the PIE-owner rule"), StringOf(ObjectOf(UserStop, TEXT("pie")), TEXT("rule")), FString(TEXT("pie_owner")));

	for (const TCHAR* Read : { TEXT("ping"), TEXT("editor_get_state"), TEXT("actor_list"), TEXT("lease_status"), TEXT("editor_pie_actor_list") })
	{
		TestNotEqual(*FString::Printf(TEXT("%s is not refused during PIE"), Read), CodeOf(Send(*Router, 900101, Owner, Read)), FString(TEXT("pie_active")));
	}
	TestFalse(TEXT("no PIE request was queued"), GEditor && GEditor->IsPlaySessionRequestQueued());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRouterPieOwnerDriveTest,
	"Hayba.MCP.State.RouterPieOwnerDrive",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRouterPieOwnerDriveTest::RunTest(const FString& Parameters)
{
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;
	ON_SCOPE_EXIT { CancelQueuedPie(); };

	const FString OwnerA = MakeTestOwner();
	const FString OwnerB = MakeTestOwner();
	AddExpectedMessagePlain(FString::Printf(TEXT("pie_active: refused 'editor_pie_press_key' from '%s'"), *OwnerB),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	AddExpectedMessagePlain(FString::Printf(TEXT("pie_active: refused 'blueprint_add_node' from '%s'"), *OwnerA),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	TSharedPtr<FJsonObject> Key = MakeShared<FJsonObject>();
	Key->SetStringField(TEXT("key"), TEXT("SpaceBar"));

	{
		FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::Agent, HaybaMCPState::EPiePhase::Running, OwnerA));
		TestNotEqual(TEXT("the owner drives its PIE"), CodeOf(Send(*Router, 900111, OwnerA, TEXT("editor_pie_press_key"), Key)), FString(TEXT("pie_active")));
		const TSharedPtr<FJsonObject> Foreign = Send(*Router, 900112, OwnerB, TEXT("editor_pie_press_key"), Key);
		TestEqual(TEXT("another owner does not"), CodeOf(Foreign), FString(TEXT("pie_active")));
		TestEqual(TEXT("detail names the owner's session"), StringOf(ObjectOf(Foreign, TEXT("pie")), TEXT("pie")), TEXT("agent:") + OwnerA);
		TestEqual(TEXT("detail: rule"), StringOf(ObjectOf(Foreign, TEXT("pie")), TEXT("rule")), FString(TEXT("pie_owner")));
		TestTrue(TEXT("the message names the owner"), StringOf(Foreign, TEXT("error")).Contains(TEXT("only its owner drives it")));
		TestNotEqual(TEXT("anyone observes"), CodeOf(Send(*Router, 900112, OwnerB, TEXT("editor_pie_actor_list"))), FString(TEXT("pie_active")));
		TestEqual(TEXT("the owner cannot edit during its own PIE"), CodeOf(Send(*Router, 900111, OwnerA, TEXT("blueprint_add_node"))), FString(TEXT("pie_active")));
	}

	// R13: a PIE command slot 2 authorized skips the lease gate, even against another owner's global X.
	UHaybaMCPDeveloperSettings* Settings = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement PreviousMode = Settings->LeaseEnforcement;
	Settings->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Enforced;
	HaybaMCPLease::FTable& Table = FHaybaMCPLeaseManager::Get().Table();
	HaybaMCPLease::FRequest Request;
	Request.Owner = OwnerB;
	Request.TtlSeconds = 30.0;
	Request.Label = TEXT("test:pie-owner-drive");
	HaybaMCPAccess::FClaim Global;
	FString ParseError;
	TestTrue(TEXT("global parses"), HaybaMCPAccess::ParseResource(TEXT("global"), Global.Resource, ParseError));
	Global.bExclusive = true;
	Request.Claims.Add(Global);
	const HaybaMCPLease::FAcquireResult Held = Table.Acquire(Request);
	ON_SCOPE_EXIT
	{
		GetMutableDefault<UHaybaMCPDeveloperSettings>()->LeaseEnforcement = PreviousMode;
		FString ReleaseError;
		FHaybaMCPLeaseManager::Get().Table().Release(Held.Token, OwnerB, ReleaseError);
	};
	if (!TestEqual(TEXT("another owner holds global X"), Held.Status, HaybaMCPLease::EStatus::Granted)) return false;
	{
		FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::Agent, HaybaMCPState::EPiePhase::Running, OwnerA));
		const FString DriveCode = CodeOf(Send(*Router, 900111, OwnerA, TEXT("editor_pie_press_key"), Key));
		TestNotEqual(TEXT("the owner's drive skips the lease gate"), DriveCode, FString(TEXT("lease_conflict")));
		TestNotEqual(TEXT("and is not pie_active"), DriveCode, FString(TEXT("pie_active")));
		TestNotEqual(TEXT("the owner's stop skips the lease gate"), CodeOf(Send(*Router, 900111, OwnerA, TEXT("editor_stop_pie"))), FString(TEXT("lease_conflict")));
	}
	{
		// Control: with no PIE the same stop is not authorized by slot 2 and meets the lease gate.
		FHaybaMCPEditorState::FScopedPieOverride NoSession(HaybaMCPState::FPieState{});
		TestEqual(TEXT("without PIE authorization the lease gate refuses"), CodeOf(Send(*Router, 900111, OwnerA, TEXT("editor_stop_pie"))), FString(TEXT("lease_conflict")));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRouterStopAgentPieFromAnyCallerTest,
	"Hayba.MCP.State.RouterStopAgentPieFromAnyCaller",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRouterStopAgentPieFromAnyCallerTest::RunTest(const FString& Parameters)
{
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;
	ON_SCOPE_EXIT { CancelQueuedPie(); };

	// The default advisory verbosity strips hint fields from data; ask for tips
	// so the reply keeps editor_start_pie's hint.
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const EHaybaMCPAdvisoryVerbosity PreviousVerbosity = Settings.AdvisoryVerbosity;
	Settings.AdvisoryVerbosity = EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips;
	ON_SCOPE_EXIT { FHaybaMCPSettings::Get().AdvisoryVerbosity = PreviousVerbosity; };
	// Both refusals below come from conn:900002, which the process-wide gate
	// limiter collapses to conn:*, so whether they log depends on earlier tests.
	AddExpectedMessagePlain(TEXT("pie_active: refused 'editor_pie_press_key' from 'conn:900002'"),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	AddExpectedMessagePlain(TEXT("pie_active: refused 'editor_stop_pie' from 'conn:900002'"),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	// A real queued request from an owner-less raw connection; it never reaches a tick.
	const TSharedPtr<FJsonObject> Start = Send(*Router, 900001, FString(), TEXT("editor_start_pie"));
	if (CodeOf(Start) == TEXT("pie_blocked"))
	{
		AddError(FString::Printf(TEXT("a loaded Blueprint would open a modal before play, so this test cannot queue PIE: %s"),
			*StringOf(Start, TEXT("error"))));
		return false;
	}
	TestTrue(TEXT("editor_start_pie succeeds"), BoolOf(Start, TEXT("ok")));
	const TSharedPtr<FJsonObject> Started = ObjectOf(Start, TEXT("data"));
	TestTrue(TEXT("pie_requested"), BoolOf(Started, TEXT("pie_requested")));
	TestTrue(TEXT("pie_started is kept for older clients"), BoolOf(Started, TEXT("pie_started")));
	TestEqual(TEXT("pie_owner names the connection"), StringOf(Started, TEXT("pie_owner")), FString(TEXT("agent:conn:900001")));
	TestFalse(TEXT("a hint says how to wait"), StringOf(Started, TEXT("hint")).IsEmpty());
	TestTrue(TEXT("a request is queued"), GEditor && GEditor->IsPlaySessionRequestQueued());
	const HaybaMCPState::FPieState Queued = FHaybaMCPEditorState::Get().CurrentPie();
	TestEqual(TEXT("the queued session is the agent's"), Queued.Kind, HaybaMCPState::EPieKind::Agent);
	TestEqual(TEXT("queued"), Queued.Phase, HaybaMCPState::EPiePhase::Queued);
	TestEqual(TEXT("owned by conn:900001"), Queued.Owner, FString(TEXT("conn:900001")));

	TSharedPtr<FJsonObject> Key = MakeShared<FJsonObject>();
	Key->SetStringField(TEXT("key"), TEXT("SpaceBar"));
	const TSharedPtr<FJsonObject> Drive = Send(*Router, 900002, FString(), TEXT("editor_pie_press_key"), Key);
	TestEqual(TEXT("another connection does not drive it"), CodeOf(Drive), FString(TEXT("pie_active")));
	TestEqual(TEXT("detail: queued agent session"), StringOf(ObjectOf(Drive, TEXT("pie")), TEXT("phase")), FString(TEXT("queued")));

	AddExpectedMessagePlain(TEXT("editor_stop_pie: 'conn:900002' stopped an agent PIE owned by 'conn:900001'"),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
	const TSharedPtr<FJsonObject> Stop = Send(*Router, 900002, FString(), TEXT("editor_stop_pie"));
	TestTrue(TEXT("any connection stops an agent PIE"), BoolOf(Stop, TEXT("ok")));
	TestTrue(TEXT("pie_stopped"), BoolOf(ObjectOf(Stop, TEXT("data")), TEXT("pie_stopped")));
	TestTrue(TEXT("a queued session is cancelled, not left to start"), BoolOf(ObjectOf(Stop, TEXT("data")), TEXT("cancelled_queued_request")));
	TestFalse(TEXT("nothing is queued any more"), GEditor && GEditor->IsPlaySessionRequestQueued());
	TestEqual(TEXT("no PIE"), FHaybaMCPEditorState::Get().CurrentPie().Kind, HaybaMCPState::EPieKind::None);

	{
		FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::User, HaybaMCPState::EPiePhase::Running));
		const TSharedPtr<FJsonObject> UserStop = Send(*Router, 900002, FString(), TEXT("editor_stop_pie"));
		TestEqual(TEXT("nobody stops the user's PIE"), CodeOf(UserStop), FString(TEXT("pie_active")));
		TestEqual(TEXT("detail: user"), StringOf(ObjectOf(UserStop, TEXT("pie")), TEXT("pie")), FString(TEXT("user")));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateStartPieBlockedByModalTest,
	"Hayba.MCP.State.StartPieBlockedByModal",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateStartPieBlockedByModalTest::RunTest(const FString& Parameters)
{
	// Pure: the engine's condition (PlayLevel.cpp:1276-1300).
	{
		using namespace HaybaMCPState;
		FBlueprintPlayFacts Errored;
		Errored.bError = true;
		Errored.bDisplayCompilePIEWarning = true;
		TestEqual(TEXT("an errored Blueprint opens the errors dialog"), PlayModalFor(Errored, false), EPlayModal::ErroredDialog);
		FBlueprintPlayFacts Acknowledged = Errored;
		Acknowledged.bDisplayCompilePIEWarning = false;
		TestEqual(TEXT("an acknowledged error does not"), PlayModalFor(Acknowledged, false), EPlayModal::None);
		FBlueprintPlayFacts Diffing = Errored;
		Diffing.bForDiffing = true;
		TestEqual(TEXT("a diff copy is ignored"), PlayModalFor(Diffing, false), EPlayModal::None);
		FBlueprintPlayFacts DirtyCode;
		DirtyCode.bDirty = true;
		TestEqual(TEXT("a dirty Blueprint prompts when the editor asks first"), PlayModalFor(DirtyCode, true), EPlayModal::RecompilePrompt);
		TestEqual(TEXT("auto-recompile opens no prompt"), PlayModalFor(DirtyCode, false), EPlayModal::None);
		FBlueprintPlayFacts DirtyData = DirtyCode;
		DirtyData.bDataOnly = true;
		TestEqual(TEXT("a data-only Blueprint never prompts"), PlayModalFor(DirtyData, true), EPlayModal::None);
		FBlueprintPlayFacts Fresh = Errored;
		Fresh.bUpToDate = true;
		TestEqual(TEXT("an up-to-date Blueprint is skipped"), PlayModalFor(Fresh, true), EPlayModal::None);
		TestEqual(TEXT("the pie_blocked text"),
			FormatPieBlockedMessage(2, TEXT("/Game/A/BP_A.BP_A"), EPlayModal::ErroredDialog),
			FString(TEXT("pie_blocked: 'editor_start_pie' was not run: 2 Blueprint(s) would open a modal dialog before play (/Game/A/BP_A.BP_A is errored). Compile or fix them first.")));
	}

	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;
	ON_SCOPE_EXIT { CancelQueuedPie(); };

	const FString AssetName = TEXT("BP_PieBlocked_") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8);
	UPackage* Package = CreatePackage(*(TEXT("/Game/__HaybaTest__/") + AssetName));
	if (!TestNotNull(TEXT("scratch package"), Package)) return false;
	Package->SetFlags(RF_Transient);
	UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Package, FName(*AssetName), BPTYPE_Normal);
	if (!TestNotNull(TEXT("scratch Blueprint"), Blueprint)) return false;
	ON_SCOPE_EXIT
	{
		Blueprint->Status = BS_UpToDate;
		Blueprint->bDisplayCompilePIEWarning = false;
		Package->SetDirtyFlag(false);
		Blueprint->ClearFlags(RF_Public | RF_Standalone);
		Blueprint->MarkAsGarbage();
		Package->MarkAsGarbage();
	};
	Blueprint->Status = BS_Error;
	Blueprint->bDisplayCompilePIEWarning = true;

	const TSharedPtr<FJsonObject> Reply = Send(*Router, 900121, MakeTestOwner(), TEXT("editor_start_pie"));
	TestFalse(TEXT("editor_start_pie is refused"), BoolOf(Reply, TEXT("ok")));
	TestEqual(TEXT("with the promoted top-level code pie_blocked"), CodeOf(Reply), FString(TEXT("pie_blocked")));
	TestTrue(TEXT("the error names the command"), StringOf(Reply, TEXT("error")).StartsWith(TEXT("pie_blocked: 'editor_start_pie' was not run: ")));
	const TSharedPtr<FJsonObject> Advisory = ObjectOf(Reply, TEXT("advisory"));
	TestEqual(TEXT("retryable"), StringOf(Advisory, TEXT("state")), FString(TEXT("retryable_failure")));
	TestEqual(TEXT("nothing started"), StringOf(Advisory, TEXT("mutation_status")), FString(TEXT("not_started")));
	const TSharedPtr<FJsonObject> Data = ObjectOf(Reply, TEXT("data"));
	TestTrue(TEXT("blocked_count counts it"), NumberOf(Data, TEXT("blocked_count")) >= 1.0);
	const TArray<TSharedPtr<FJsonValue>>* Blocked = nullptr;
	bool bListed = false;
	if (TestTrue(TEXT("blocked_assets is a list"), Data.IsValid() && Data->TryGetArrayField(TEXT("blocked_assets"), Blocked) && Blocked))
	{
		TestTrue(TEXT("at most 16 listed"), Blocked->Num() <= HaybaMCPState::MaxBlockedAssetsListed);
		for (const TSharedPtr<FJsonValue>& Item : *Blocked)
		{
			const TSharedPtr<FJsonObject>* Entry = nullptr;
			if (Item.IsValid() && Item->TryGetObject(Entry) && Entry
				&& StringOf(*Entry, TEXT("asset")) == Blueprint->GetPathName()
				&& StringOf(*Entry, TEXT("status")) == TEXT("errored"))
			{
				bListed = true;
			}
		}
	}
	TestTrue(TEXT("the errored scratch Blueprint is listed"), bListed);
	TestFalse(TEXT("no PIE request was queued"), GEditor && GEditor->IsPlaySessionRequestQueued());
	TestEqual(TEXT("no session was attributed"), FHaybaMCPEditorState::Get().CurrentPie().Kind, HaybaMCPState::EPieKind::None);
	return true;
}

namespace HaybaMCPStateTest
{
	void ExpectNoSecretKeys(FAutomationTestBase& Test, const TSharedPtr<FJsonObject>& Obj, const FString& Where)
	{
		static const TCHAR* const SecretWords[] = { TEXT("token"), TEXT("secret"), TEXT("password"), TEXT("passwd"),
			TEXT("pwd"), TEXT("credential"), TEXT("cookie"), TEXT("authorization"), TEXT("key") };
		if (!Obj.IsValid()) return;
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Field : Obj->Values)
		{
			for (const TCHAR* Word : SecretWords)
			{
				Test.TestFalse(*FString::Printf(TEXT("%s.%s ends in a secret word"), *Where, *Field.Key), Field.Key.EndsWith(Word, ESearchCase::IgnoreCase));
			}
			const TSharedPtr<FJsonObject>* Child = nullptr;
			if (Field.Value.IsValid() && Field.Value->TryGetObject(Child) && Child)
			{
				ExpectNoSecretKeys(Test, *Child, Where + TEXT(".") + Field.Key);
			}
		}
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateGetStateShapeTest,
	"Hayba.MCP.State.GetStateShape",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateGetStateShapeTest::RunTest(const FString& Parameters)
{
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid()) return false;
	const FString Owner = MakeTestOwner();

	{
		HaybaMCPState::FPieState AgentSession = MakePie(HaybaMCPState::EPieKind::Agent, HaybaMCPState::EPiePhase::Running, Owner);
		AgentSession.Since = FPlatformTime::Seconds() - 3.0;
		FHaybaMCPEditorState::FScopedPieOverride Forced(AgentSession);
		TSharedPtr<FJsonObject> NoDirty = MakeShared<FJsonObject>();
		NoDirty->SetBoolField(TEXT("include_dirty"), false);
		const TSharedPtr<FJsonObject> Reply = Send(*Router, 900201, Owner, TEXT("editor_get_state"), NoDirty);
		TestTrue(TEXT("editor_get_state answers"), BoolOf(Reply, TEXT("ok")));
		const TSharedPtr<FJsonObject> Data = ObjectOf(Reply, TEXT("data"));
		// Every field, through the router's response limits (R-21).
		for (const TCHAR* Field : { TEXT("ok"), TEXT("map"), TEXT("selection_count"), TEXT("caller_owner"), TEXT("pie"),
			TEXT("pie_running"), TEXT("pie_phase"), TEXT("pie_since_s"), TEXT("pie_simulating"), TEXT("compiling"),
			TEXT("shader_jobs"), TEXT("saving"), TEXT("building"), TEXT("editor_unsafe"), TEXT("python_unhealthy"),
			TEXT("health"), TEXT("dirty_packages_skipped") })
		{
			TestTrue(*FString::Printf(TEXT("editor_get_state reports %s"), Field), Data.IsValid() && Data->HasField(Field));
		}
		TestFalse(TEXT("include_dirty:false skips the package walk"), Data.IsValid() && Data->HasField(TEXT("dirty_packages")));
		TestFalse(TEXT("and its count"), Data.IsValid() && Data->HasField(TEXT("dirty_count")));
		TestEqual(TEXT("and says why"), StringOf(Data, TEXT("dirty_packages_skipped")), FString(TEXT("include_dirty")));
		TestEqual(TEXT("pie names the agent"), StringOf(Data, TEXT("pie")), TEXT("agent:") + Owner);
		TestEqual(TEXT("pie_phase"), StringOf(Data, TEXT("pie_phase")), FString(TEXT("running")));
		TestTrue(TEXT("pie_running from the resolved state"), BoolOf(Data, TEXT("pie_running")));
		TestTrue(TEXT("pie_since_s counts the session"), NumberOf(Data, TEXT("pie_since_s")) >= 2.0);
		TestEqual(TEXT("caller_owner is the envelope owner"), StringOf(Data, TEXT("caller_owner")), Owner);
		TestTrue(TEXT("health is an object"), ObjectOf(Data, TEXT("health")).IsValid());
		ExpectNoSecretKeys(*this, Data, TEXT("data"));
	}
	{
		FHaybaMCPEditorState::FScopedPieOverride NoSession(HaybaMCPState::FPieState{});
		const TSharedPtr<FJsonObject> Data = ObjectOf(Send(*Router, 900201, Owner, TEXT("editor_get_state")), TEXT("data"));
		TestEqual(TEXT("no PIE"), StringOf(Data, TEXT("pie")), FString(TEXT("none")));
		TestEqual(TEXT("phase none"), StringOf(Data, TEXT("pie_phase")), FString(TEXT("none")));
		TestFalse(TEXT("pie_running false"), BoolOf(Data, TEXT("pie_running")));
		TestTrue(TEXT("the default still walks dirty packages"), Data.IsValid() && Data->HasField(TEXT("dirty_packages")));
		TestTrue(TEXT("with a count"), Data.IsValid() && Data->HasField(TEXT("dirty_count")));
	}
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
