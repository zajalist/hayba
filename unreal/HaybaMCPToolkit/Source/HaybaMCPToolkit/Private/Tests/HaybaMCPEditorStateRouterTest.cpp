#include "Misc/AutomationTest.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPAccessPolicy.h"
#include "HaybaMCPCommandSets.h"
#include "HaybaMCPDeveloperSettings.h"
#include "HaybaMCPEditorHealth.h"
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
#include "EdGraphSchema_K2.h"
#include "IPIEAuthorizer.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/CommandLine.h"
#include "Misc/Guid.h"
#include "Misc/Parse.h"
#include "Misc/ScopeExit.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/HaybaMCPLatentTest.h"
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
		TestEqual(TEXT("an errored Blueprint opens the errors dialog"), PlayModalFor(Errored), EPlayModal::ErroredDialog);
		FBlueprintPlayFacts Acknowledged = Errored;
		Acknowledged.bDisplayCompilePIEWarning = false;
		TestEqual(TEXT("an acknowledged error does not"), PlayModalFor(Acknowledged), EPlayModal::None);
		FBlueprintPlayFacts Diffing = Errored;
		Diffing.bForDiffing = true;
		TestEqual(TEXT("a diff copy is ignored"), PlayModalFor(Diffing), EPlayModal::None);
		FBlueprintPlayFacts DirtyCode;
		DirtyCode.bDirty = true;
		// Prompted, or auto-recompiled into the errors dialog if the recompile fails.
		TestEqual(TEXT("a dirty code Blueprint is a risk under either compile setting"), PlayModalFor(DirtyCode), EPlayModal::DirtyCode);
		FBlueprintPlayFacts DirtyData = DirtyCode;
		DirtyData.bDataOnly = true;
		TestEqual(TEXT("a data-only Blueprint never prompts"), PlayModalFor(DirtyData), EPlayModal::None);
		FBlueprintPlayFacts Fresh = Errored;
		Fresh.bUpToDate = true;
		TestEqual(TEXT("an up-to-date Blueprint is skipped"), PlayModalFor(Fresh), EPlayModal::None);
		TestEqual(TEXT("the dirty pie_blocked text names blueprint_compile"),
			FormatPieBlockedMessage(1, TEXT("/Game/A/BP_B.BP_B"), EPlayModal::DirtyCode),
			FString(TEXT("pie_blocked: 'editor_start_pie' was not run: 1 Blueprint(s) would open a modal dialog before play (/Game/A/BP_B.BP_B is dirty). Compile each listed Blueprint with blueprint_compile and fix what it reports, then call editor_start_pie again.")));
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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateStartPieBlockedByDirtyCodeTest,
	"Hayba.MCP.State.StartPieBlockedByDirtyCode",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateStartPieBlockedByDirtyCodeTest::RunTest(const FString& Parameters)
{
	// The common agent path: an edit leaves a code Blueprint dirty (and possibly broken),
	// then editor_start_pie. Under auto-recompile (the engine default) a failed recompile
	// opens the errors dialog whatever bDisplayCompilePIEWarning says (PlayLevel.cpp:1352-1373).
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;
	ON_SCOPE_EXIT { CancelQueuedPie(); };

	ULevelEditorPlaySettings* PlaySettings = GetMutableDefault<ULevelEditorPlaySettings>();
	const bool bPreviousAutoRecompile = PlaySettings->AutoRecompileBlueprints;
	PlaySettings->AutoRecompileBlueprints = true;
	ON_SCOPE_EXIT { GetMutableDefault<ULevelEditorPlaySettings>()->AutoRecompileBlueprints = bPreviousAutoRecompile; };

	const FString AssetName = TEXT("BP_PieDirty_") + FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8);
	UPackage* Package = CreatePackage(*(TEXT("/Game/__HaybaTest__/") + AssetName));
	if (!TestNotNull(TEXT("scratch package"), Package)) return false;
	Package->SetFlags(RF_Transient);
	UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Package, FName(*AssetName), BPTYPE_Normal);
	if (!TestNotNull(TEXT("scratch Blueprint"), Blueprint)) return false;
	ON_SCOPE_EXIT
	{
		Blueprint->Status = BS_UpToDate;
		Package->SetDirtyFlag(false);
		Blueprint->ClearFlags(RF_Public | RF_Standalone);
		Blueprint->MarkAsGarbage();
		Package->MarkAsGarbage();
	};
	// A member variable makes it a code Blueprint (IsDataOnlyBlueprint is false).
	FBPVariableDescription Variable;
	Variable.VarName = TEXT("bHaybaPieGate");
	Variable.VarGuid = FGuid::NewGuid();
	Variable.VarType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	Blueprint->NewVariables.Add(Variable);
	if (!TestFalse(TEXT("the scratch Blueprint is a code Blueprint"), FBlueprintEditorUtils::IsDataOnlyBlueprint(Blueprint))) return false;
	Blueprint->Status = BS_Dirty;
	Blueprint->bDisplayCompilePIEWarning = false;

	const FString Owner = MakeTestOwner();
	const TSharedPtr<FJsonObject> Reply = Send(*Router, 900131, Owner, TEXT("editor_start_pie"));
	TestFalse(TEXT("editor_start_pie is refused under auto-recompile"), BoolOf(Reply, TEXT("ok")));
	TestEqual(TEXT("with pie_blocked"), CodeOf(Reply), FString(TEXT("pie_blocked")));
	TestTrue(TEXT("the error says to run blueprint_compile"), StringOf(Reply, TEXT("error")).Contains(TEXT("blueprint_compile")));
	const TSharedPtr<FJsonObject> Data = ObjectOf(Reply, TEXT("data"));
	const TArray<TSharedPtr<FJsonValue>>* Blocked = nullptr;
	bool bListedDirty = false;
	if (TestTrue(TEXT("blocked_assets is a list"), Data.IsValid() && Data->TryGetArrayField(TEXT("blocked_assets"), Blocked) && Blocked))
	{
		TestTrue(TEXT("at most 16 listed"), Blocked->Num() <= HaybaMCPState::MaxBlockedAssetsListed);
		for (const TSharedPtr<FJsonValue>& Item : *Blocked)
		{
			const TSharedPtr<FJsonObject>* Entry = nullptr;
			if (Item.IsValid() && Item->TryGetObject(Entry) && Entry
				&& StringOf(*Entry, TEXT("asset")) == Blueprint->GetPathName()
				&& StringOf(*Entry, TEXT("status")) == TEXT("dirty"))
			{
				bListedDirty = true;
			}
		}
	}
	TestTrue(TEXT("the dirty scratch Blueprint is listed as dirty"), bListedDirty);
	TestFalse(TEXT("no PIE request was queued"), GEditor && GEditor->IsPlaySessionRequestQueued());
	TestEqual(TEXT("no session was attributed"), FHaybaMCPEditorState::Get().CurrentPie().Kind, HaybaMCPState::EPieKind::None);

	// Compiled (clean), the same Blueprint no longer blocks: the request is queued, then cancelled.
	Blueprint->Status = BS_UpToDate;
	const TSharedPtr<FJsonObject> Clean = Send(*Router, 900131, Owner, TEXT("editor_start_pie"));
	if (CodeOf(Clean) == TEXT("pie_blocked"))
	{
		AddError(FString::Printf(TEXT("another loaded Blueprint blocks PIE in this host: %s"), *StringOf(Clean, TEXT("error"))));
		return false;
	}
	TestTrue(TEXT("a clean Blueprint passes the preflight"), BoolOf(Clean, TEXT("ok")));
	TestTrue(TEXT("pie_requested"), BoolOf(ObjectOf(Clean, TEXT("data")), TEXT("pie_requested")));
	TestTrue(TEXT("a request is queued"), GEditor && GEditor->IsPlaySessionRequestQueued());
	const TSharedPtr<FJsonObject> Stop = Send(*Router, 900131, Owner, TEXT("editor_stop_pie"));
	TestTrue(TEXT("the owner cancels its queued session"), BoolOf(ObjectOf(Stop, TEXT("data")), TEXT("cancelled_queued_request")));
	TestFalse(TEXT("nothing is queued any more"), GEditor && GEditor->IsPlaySessionRequestQueued());
	TestEqual(TEXT("no PIE"), FHaybaMCPEditorState::Get().CurrentPie().Kind, HaybaMCPState::EPieKind::None);
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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStatePieSafeDriftTest,
	"Hayba.MCP.State.PieSafeDrift",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStatePieSafeDriftTest::RunTest(const FString& Parameters)
{
	using namespace HaybaMCPState;
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid()) return false;
	const TSet<FString> Registered(Router->GetAllCommands());
	TestTrue(TEXT("a plausible command surface is registered"), Registered.Num() > 100);

	// Spec T2 design 1, plus asset_browse and test_cancel (ledger C15) and the 18 R-12 reads
	// (spec, Maintainer decisions 2026-09-28).
	// lease_* is left out: those are PIE-safe by prefix, whatever set lists them.
	static const TCHAR* const ExpectedSafe[] = {
		TEXT("ping"), TEXT("editor_get_state"), TEXT("get_setting"), TEXT("copilot_key_status"), TEXT("batch_status"),
		TEXT("hayba_propose_plan"), TEXT("ui_memory_set"), TEXT("ui_tool_stream"), TEXT("ui_tool_stream_new_turn"),
		TEXT("editor_get_output_log"), TEXT("editor_stream_log"), TEXT("editor_get_performance_stats"), TEXT("editor_get_perf_stats"),
		TEXT("test_cancel"),
		TEXT("editor_pie_assert"), TEXT("editor_pie_wait_for"), TEXT("editor_pie_screenshot"), TEXT("editor_pie_widget_tree"),
		TEXT("editor_pie_actor_list"), TEXT("editor_pie_actor_inspect"), TEXT("editor_pie_project_world"),
		TEXT("docs_search"), TEXT("docs_lookup_api"), TEXT("docs_lookup_class"), TEXT("asset_search"), TEXT("asset_registry_query"),
		TEXT("asset_get_info"), TEXT("asset_get_dependencies"), TEXT("asset_get_referencers"), TEXT("asset_get_references"), TEXT("asset_browse"),
		TEXT("actor_list"), TEXT("actor_get_properties"), TEXT("actor_get_components"), TEXT("object_get_property"),
		TEXT("blueprint_get_info"), TEXT("blueprint_inspect_graph"), TEXT("anim_blueprint_get_info"), TEXT("bt_get_info"),
		TEXT("material_get_info"), TEXT("material_list"), TEXT("data_get"), TEXT("level_get_info"), TEXT("level_list"),
		TEXT("level_get_spatial_index"), TEXT("scene_get_actor_relations"), TEXT("spline_get_info"), TEXT("texture_get_info"),
		TEXT("texture_list"), TEXT("mesh_get_info"), TEXT("mesh_list"), TEXT("ui_query"), TEXT("ui_list_widget_types"),
		TEXT("ui_list_widget_blueprints"), TEXT("ui_report_findings"), TEXT("audio_list"), TEXT("audio_active_sounds"),
		TEXT("audio_asset_inspect"), TEXT("audio_meter_read"), TEXT("wp_get_cells"), TEXT("wp_get_streaming_state"),
		TEXT("project_get_info"), TEXT("project_get_settings"), TEXT("project_list_plugins"), TEXT("test_list"), TEXT("test_get_log"),
		TEXT("build_status"), TEXT("foliage_list_types"), TEXT("pcg_list_assets"), TEXT("list_pcg_assets"), TEXT("pcg_list_node_classes"),
		TEXT("list_node_classes"), TEXT("pcg_get_node_details"), TEXT("get_node_details"),
		TEXT("wait_for_idle"), TEXT("wait_for_shaders"), TEXT("asset_validate"), TEXT("material_validate"),
		TEXT("mesh_audit"), TEXT("mesh_list_dynamic"), TEXT("mesh_topology_stats"), TEXT("metasound_inspect"),
		TEXT("metasound_list"), TEXT("pcg_export_graph"), TEXT("pcg_read_node_output"), TEXT("pcg_validate_graph"),
		TEXT("placement_validate"), TEXT("scene_export"), TEXT("scene_validate_physics"), TEXT("texture_audit"),
		TEXT("ui_measure_text"), TEXT("copilot_get_key"),
	};
	TSet<FString> Expected;
	for (const TCHAR* Name : ExpectedSafe) Expected.Add(Name);
	TSet<FString> Actual;
	Actual.Append(HaybaMCPCommandSets::ControlPlaneCommands());
	Actual.Append(HaybaMCPCommandSets::PieObservationCommands());
	Actual.Append(HaybaMCPCommandSets::ReadCommands());
	TSet<FString> ActualNonLease;
	for (const FString& Cmd : Actual)
	{
		if (!Cmd.StartsWith(TEXT("lease_"))) ActualNonLease.Add(Cmd);
	}
	for (const FString& Cmd : Expected.Difference(ActualNonLease))
	{
		AddError(FString::Printf(TEXT("the PIE-safe sets are missing %s"), *Cmd));
	}
	for (const FString& Cmd : ActualNonLease.Difference(Expected))
	{
		AddError(FString::Printf(TEXT("the PIE-safe sets gained %s without review"), *Cmd));
	}

	for (const FString& Cmd : Actual)
	{
		TestTrue(*FString::Printf(TEXT("PIE-safe %s is registered or router-inline"), *Cmd),
			Registered.Contains(Cmd) || HaybaMCPCommandSets::RouterInlineCommands().Contains(Cmd));
		TestEqual(*FString::Printf(TEXT("%s rules Safe"), *Cmd), PieRuleFor(Cmd), EPieRule::Safe);
	}
	for (const FString& Cmd : PieOwnerCommands())
	{
		TestTrue(*FString::Printf(TEXT("PIE-owner %s is registered"), *Cmd), Registered.Contains(Cmd));
		TestFalse(*FString::Printf(TEXT("PIE-owner %s is in no safe set"), *Cmd), Actual.Contains(Cmd));
	}
	TArray<FString> RefusedByDefault;
	for (const FString& Cmd : Registered)
	{
		if (Cmd.StartsWith(TEXT("editor_pie_")))
		{
			TestTrue(*FString::Printf(TEXT("%s has a deliberate PIE rule"), *Cmd),
				HaybaMCPCommandSets::PieObservationCommands().Contains(Cmd) || PieOwnerCommands().Contains(Cmd));
		}
		if (Cmd.StartsWith(TEXT("lease_")))
		{
			TestEqual(*FString::Printf(TEXT("%s is PIE-safe"), *Cmd), PieRuleFor(Cmd), EPieRule::Safe);
		}
		if (PieRuleFor(Cmd) == EPieRule::Refuse)
		{
			RefusedByDefault.Add(Cmd);
		}
	}
	TestFalse(TEXT("wp_region_load is a batch step, never a PIE-safe command"), Actual.Contains(TEXT("wp_region_load")));
	TestFalse(TEXT("wp_region_unload is a batch step, never a PIE-safe command"), Actual.Contains(TEXT("wp_region_unload")));
	for (const TCHAR* Writer : { TEXT("blueprint_add_node"), TEXT("python_run"), TEXT("editor_start_pie"), TEXT("editor_batch"),
		TEXT("level_save"), TEXT("material_set_param"), TEXT("asset_delete") })
	{
		TestEqual(*FString::Printf(TEXT("%s stays refused"), Writer), PieRuleFor(Writer), EPieRule::Refuse);
	}
	// Printed so a reviewer sees what is still refused during PIE by default. None of the
	// 18 R-12 reads may be in it.
	for (const TCHAR* Read : { TEXT("wait_for_idle"), TEXT("wait_for_shaders"), TEXT("asset_validate"), TEXT("material_validate"), TEXT("mesh_audit"), TEXT("mesh_list_dynamic"),
		TEXT("mesh_topology_stats"), TEXT("metasound_inspect"), TEXT("metasound_list"), TEXT("pcg_export_graph"), TEXT("pcg_read_node_output"), TEXT("pcg_validate_graph"),
		TEXT("placement_validate"), TEXT("scene_export"), TEXT("scene_validate_physics"), TEXT("texture_audit"), TEXT("ui_measure_text"), TEXT("copilot_get_key") })
	{
		TestEqual(*FString::Printf(TEXT("R-12 read %s is allowed during PIE"), Read), PieRuleFor(Read), EPieRule::Safe);
		TestFalse(*FString::Printf(TEXT("R-12 read %s is not refused by default"), Read), RefusedByDefault.Contains(Read));
	}
	// The same decision through the router: during a user PIE two of the 18 pass
	// slot 2 and reach their handler. Without parameters the handler answers a
	// missing-parameter error, which is enough here: pie_active did not refuse.
	if (NoRealPie(*this))
	{
		FHaybaMCPEditorState::FScopedPieOverride Forced(MakePie(HaybaMCPState::EPieKind::User, HaybaMCPState::EPiePhase::Running));
		const FString ReadOwner = MakeTestOwner();
		for (const TCHAR* Read : { TEXT("material_validate"), TEXT("ui_measure_text") })
		{
			const TSharedPtr<FJsonObject> Reply = Send(*Router, 900190, ReadOwner, Read);
			TestTrue(*FString::Printf(TEXT("R-12 read %s answers during a user PIE"), Read), Reply.IsValid());
			TestNotEqual(*FString::Printf(TEXT("R-12 read %s passes slot 2 during a user PIE"), Read),
				CodeOf(Reply), FString(TEXT("pie_active")));
		}
	}
	RefusedByDefault.Sort();
	AddInfo(FString::Printf(TEXT("refused during PIE by default (%d): %s"), RefusedByDefault.Num(), *FString::Join(RefusedByDefault, TEXT(", "))));
	// The complement, for the M5 recipe of the handoffs: a list of names, never a
	// pattern. lease_* is left out because it is PIE-safe by prefix.
	TArray<FString> SafeSorted = ActualNonLease.Array();
	SafeSorted.Sort();
	AddInfo(FString::Printf(TEXT("PIE-safe (%d): %s"), SafeSorted.Num(), *FString::Join(SafeSorted, TEXT(", "))));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateBatchHoldsDuringPIETest,
	"Hayba.MCP.State.BatchHoldsDuringPIE",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateBatchHoldsDuringPIETest::RunTest(const FString& Parameters)
{
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;

	struct FHoldContext
	{
		FString Owner;
		FString LeaseHandle;
		FString JobId;
		double ExpiresBefore = 0.0;
		TUniquePtr<FHaybaMCPEditorState::FScopedPieOverride> Pie;
	};
	const TSharedRef<FHoldContext> Ctx = MakeShared<FHoldContext>();
	Ctx->Owner = MakeTestOwner();

	// A 10 s lease: the pump's keep-alive (below 30 s -> 90 s) must renew it during the hold.
	HaybaMCPLease::FRequest Request;
	Request.Owner = Ctx->Owner;
	Request.TtlSeconds = 10.0;
	Request.Label = TEXT("test:batch-hold");
	HaybaMCPAccess::FClaim Claim;
	FString ParseError;
	TestTrue(TEXT("asset claim parses"), HaybaMCPAccess::ParseResource(
		TEXT("asset:/Game/__HaybaTest__/BatchHold_") + Ctx->Owner.Right(8), Claim.Resource, ParseError));
	Claim.bExclusive = true;
	Request.Claims.Add(Claim);
	const HaybaMCPLease::FAcquireResult Granted = FHaybaMCPLeaseManager::Get().Table().Acquire(Request);
	if (!TestEqual(TEXT("lease granted"), Granted.Status, HaybaMCPLease::EStatus::Granted)) return false;
	Ctx->LeaseHandle = Granted.Token;
	Ctx->ExpiresBefore = Granted.ExpiresAt;

	TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("lease"), Ctx->LeaseHandle);
	TArray<TSharedPtr<FJsonValue>> Steps;
	for (int32 I = 0; I < 2; ++I)
	{
		TSharedPtr<FJsonObject> Step = MakeShared<FJsonObject>();
		Step->SetStringField(TEXT("cmd"), TEXT("ping"));
		Step->SetStringField(TEXT("fence_after"), TEXT("none"));
		Steps.Add(MakeShared<FJsonValueObject>(Step));
	}
	Params->SetArrayField(TEXT("steps"), Steps);
	FHaybaMCPSettings& Settings = FHaybaMCPSettings::Get();
	const bool bPlanModeWas = Settings.bPlanModeEnabled;
	Settings.bPlanModeEnabled = false;   // editor_batch is plan-gated; the test is not about Plan Mode
	const TSharedPtr<FJsonObject> Started = Send(*Router, 900301, Ctx->Owner, TEXT("editor_batch"), Params);
	Settings.bPlanModeEnabled = bPlanModeWas;
	if (!TestTrue(TEXT("editor_batch starts"), BoolOf(Started, TEXT("ok"))))
	{
		FString ReleaseError;
		FHaybaMCPLeaseManager::Get().Table().Release(Ctx->LeaseHandle, Ctx->Owner, ReleaseError);
		return false;
	}
	Ctx->JobId = StringOf(ObjectOf(Started, TEXT("data")), TEXT("job_id"));

	// R-11: a queued request holds the batch like a running session. Set before the first pump tick.
	Ctx->Pie = MakeUnique<FHaybaMCPEditorState::FScopedPieOverride>(
		MakePie(HaybaMCPState::EPieKind::User, HaybaMCPState::EPiePhase::Queued));

	const TFunction<TSharedPtr<FJsonObject>()> ReadStatus = [Router, Ctx]()
	{
		TSharedPtr<FJsonObject> Query = MakeShared<FJsonObject>();
		Query->SetStringField(TEXT("job_id"), Ctx->JobId);
		return ObjectOf(Send(*Router, 900301, Ctx->Owner, TEXT("batch_status"), Query), TEXT("data"));
	};

	const double HoldStart = FPlatformTime::Seconds();
	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("a 1.5 s hold under a queued PIE"),
		[HoldStart]() { return FPlatformTime::Seconds() - HoldStart >= 1.5; }, 3.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Ctx, ReadStatus]()
	{
		const TSharedPtr<FJsonObject> During = ReadStatus();
		TestEqual(TEXT("still running"), StringOf(During, TEXT("status")), FString(TEXT("running")));
		TestEqual(TEXT("no step ran during PIE"), NumberOf(During, TEXT("steps_run")), 0.0);
		TestTrue(TEXT("the status says it is held"), BoolOf(During, TEXT("held")));
		TestEqual(TEXT("by PIE"), StringOf(During, TEXT("busy")), FString(TEXT("pie")));
		TestTrue(TEXT("held_s counts the hold"), NumberOf(During, TEXT("held_s")) >= 1.0);
		const HaybaMCPLease::FLease* Lease = FHaybaMCPLeaseManager::Get().Table().FindLease(Ctx->LeaseHandle);
		TestTrue(TEXT("the batch lease kept renewing during the hold"), Lease && Lease->ExpiresAt > Ctx->ExpiresBefore + 60.0);
		Ctx->Pie.Reset();   // PIE ends
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("the batch resumes and finishes"),
		[ReadStatus]() { const FString Status = StringOf(ReadStatus(), TEXT("status")); return !Status.IsEmpty() && Status != TEXT("running"); }, 5.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Ctx, ReadStatus]()
	{
		const TSharedPtr<FJsonObject> After = ReadStatus();
		TestEqual(TEXT("the batch succeeds after the hold"), StringOf(After, TEXT("status")), FString(TEXT("succeeded")));
		TestEqual(TEXT("both steps ran"), NumberOf(After, TEXT("steps_run")), 2.0);
		TestTrue(TEXT("the final status keeps the held time"), NumberOf(After, TEXT("held_s")) >= 1.0);
		Ctx->Pie.Reset();
		FString ReleaseError;
		FHaybaMCPLeaseManager::Get().Table().Release(Ctx->LeaseHandle, Ctx->Owner, ReleaseError);
		return true;
	}));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRealPIETest,
	"Hayba.MCP.State.RealPIE",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRealPIETest::RunTest(const FString& Parameters)
{
	// Opt-in and owned child only: a real PIE in a shared process is too heavy for the main run.
	if (!FParse::Param(FCommandLine::Get(), TEXT("HaybaRealPIETests")))
	{
		AddInfo(TEXT("skipped: run with -HaybaRealPIETests in its own invocation"));
		return true;
	}
	const TSharedPtr<FHaybaMCPCommandHandler> Router = GetRouter(*this);
	if (!Router.IsValid() || !NoRealPie(*this)) return false;

	const FString Owner = MakeTestOwner();
	const FString Other = MakeTestOwner();
	const int32 EndSerialBefore = FHaybaMCPEditorState::Get().PieEndSerial();
	AddExpectedMessagePlain(FString::Printf(TEXT("editor_stop_pie: '%s' stopped an agent PIE owned by '%s'"), *Other, *Owner),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);

	const TSharedPtr<FJsonObject> Start = Send(*Router, 900401, Owner, TEXT("editor_start_pie"));
	if (!TestTrue(TEXT("editor_start_pie is accepted"), BoolOf(Start, TEXT("ok"))))
	{
		AddError(StringOf(Start, TEXT("error")));
		return false;
	}
	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("the agent's PIE is running"), [Owner]()
	{
		const HaybaMCPState::FPieState Pie = FHaybaMCPEditorState::Get().CurrentPie();
		return Pie.Kind == HaybaMCPState::EPieKind::Agent && Pie.Phase == HaybaMCPState::EPiePhase::Running && Pie.Owner == Owner;
	}, 10.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, Router, Owner, Other]()
	{
		TSharedPtr<FJsonObject> AddNode = MakeShared<FJsonObject>();
		AddNode->SetStringField(TEXT("path"), TEXT("/Game/__HaybaTest__/BP_RealPie"));
		TestEqual(TEXT("a write during real PIE is refused"), CodeOf(Send(*Router, 900402, Other, TEXT("blueprint_add_node"), AddNode)), FString(TEXT("pie_active")));
		TSharedPtr<FJsonObject> NoDirty = MakeShared<FJsonObject>();
		NoDirty->SetBoolField(TEXT("include_dirty"), false);
		const TSharedPtr<FJsonObject> StateData = ObjectOf(Send(*Router, 900402, Other, TEXT("editor_get_state"), NoDirty), TEXT("data"));
		TestEqual(TEXT("editor_get_state names the agent"), StringOf(StateData, TEXT("pie")), TEXT("agent:") + Owner);
		TestTrue(TEXT("another agent may stop an agent PIE"), BoolOf(Send(*Router, 900402, Other, TEXT("editor_stop_pie")), TEXT("ok")));
		return true;
	}));
	ADD_LATENT_AUTOMATION_COMMAND(FHaybaWaitUntilLatentCommand(this, TEXT("PIE has ended"), []()
	{
		return FHaybaMCPEditorState::Get().CurrentPie().Kind == HaybaMCPState::EPieKind::None;
	}, 10.0));
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, EndSerialBefore]()
	{
		TestEqual(TEXT("one session, one end"), FHaybaMCPEditorState::Get().PieEndSerial() - EndSerialBefore, 1);
		return true;
	}));
	return true;
}

// ---------------------------------------------------------------------------
// T3: asset_busy (router slot 3) through the real router. Owners are unique
// per run, ConnIds are fake (>= 900000), and assets do not exist.
// ---------------------------------------------------------------------------
namespace HaybaAssetBusyRouterTest
{
	FString NewTag()
	{
		return FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
	}

	TSharedPtr<FJsonObject> Parse(const FString& Text)
	{
		TSharedPtr<FJsonObject> Out;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		FJsonSerializer::Deserialize(Reader, Out);
		return Out;
	}

	FString StringOr(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field)
	{
		FString Out;
		if (Obj.IsValid())
		{
			Obj->TryGetStringField(Field, Out);
		}
		return Out;
	}

	TSharedPtr<FHaybaMCPCommandHandler> RouterOrNull(FAutomationTestBase& Test)
	{
		FHaybaMCPModule* Module = FModuleManager::GetModulePtr<FHaybaMCPModule>(TEXT("HaybaMCPToolkit"));
		if (!Test.TestNotNull(TEXT("toolkit module is loaded"), Module))
		{
			return nullptr;
		}
		return Module->GetCommandHandler();
	}

	FString Send(FHaybaMCPCommandHandler& Router, const FString& Cmd, const FString& Owner, int32 ConnId, const TSharedRef<FJsonObject>& Params)
	{
		const TSharedRef<FJsonObject> Envelope = MakeShared<FJsonObject>();
		Envelope->SetStringField(TEXT("id"), TEXT("busy-") + NewTag());
		Envelope->SetStringField(TEXT("cmd"), Cmd);
		Envelope->SetStringField(TEXT("owner"), Owner);
		Envelope->SetObjectField(TEXT("params"), Params);
		FString Json;
		const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Json);
		FJsonSerializer::Serialize(Envelope, Writer);
		return Router.ProcessCommand(Json, ConnId);
	}

	/** busy.assets[0] of a reply or of a state_warning, or null. */
	TSharedPtr<FJsonObject> FirstBusyAsset(const TSharedPtr<FJsonObject>& Holder)
	{
		const TSharedPtr<FJsonObject>* Busy = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Assets = nullptr;
		if (!Holder.IsValid() || !Holder->TryGetObjectField(TEXT("busy"), Busy) || !Busy
			|| !(*Busy)->TryGetArrayField(TEXT("assets"), Assets) || !Assets || Assets->Num() == 0)
		{
			return nullptr;
		}
		return (*Assets)[0]->AsObject();
	}

	void ExpectRetryablePreflight(FAutomationTestBase& Test, const FString& What, const TSharedPtr<FJsonObject>& Reply)
	{
		const TSharedPtr<FJsonObject>* Advisory = nullptr;
		if (Test.TestTrue(What + TEXT(" carries an advisory"), Reply.IsValid() && Reply->TryGetObjectField(TEXT("advisory"), Advisory) && Advisory))
		{
			Test.TestEqual(What + TEXT(" is retryable_failure"), StringOr(*Advisory, TEXT("state")), FString(TEXT("retryable_failure")));
			Test.TestEqual(What + TEXT(" ran nothing"), StringOr(*Advisory, TEXT("mutation_status")), FString(TEXT("not_started")));
		}
	}

	/** Holds asset:<AssetPath> X for Owner in the live lease table. Released
	 *  on destruction. Unbound (ConnId 0), long lane, 120 s. */
	struct FScopedAssetLease
	{
		FString Token;
		FString Owner;

		FScopedAssetLease(const FString& InOwner, const FString& AssetPath, const FString& Label)
			: Owner(InOwner)
		{
			HaybaMCPLease::FRequest Request;
			Request.Owner = Owner;
			Request.Label = Label;
			Request.Lane = HaybaMCPLease::ELane::Long;
			Request.TtlSeconds = 120.0;
			HaybaMCPAccess::FClaim Claim;
			FString Error;
			if (HaybaMCPAccess::ParseResource(TEXT("asset:") + AssetPath, Claim.Resource, Error))
			{
				Claim.bExclusive = true;
				Request.Claims.Add(Claim);
				const HaybaMCPLease::FAcquireResult Result = FHaybaMCPLeaseManager::Get().Table().Acquire(Request);
				if (Result.Status == HaybaMCPLease::EStatus::Granted)
				{
					Token = Result.Token;
				}
			}
		}

		~FScopedAssetLease()
		{
			FString Error;
			if (!Token.IsEmpty())
			{
				FHaybaMCPLeaseManager::Get().Table().Release(Token, Owner, Error);
			}
		}
	};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRouterAssetBusyStartPieTest,
	"Hayba.MCP.State.RouterAssetBusyStartPie",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRouterAssetBusyStartPieTest::RunTest(const FString& Parameters)
{
	using namespace HaybaAssetBusyRouterTest;
	const TSharedPtr<FHaybaMCPCommandHandler> Router = RouterOrNull(*this);
	if (!TestTrue(TEXT("router exists"), Router.IsValid()) || !TestNotNull(TEXT("GEditor"), GEditor))
	{
		return false;
	}

	// A stray real fault must not turn every reply into editor_unsafe (R-7).
	// No PIE, so slot 2 passes.
	FHaybaEditorHealth::FScopedOverrideForTests Health;
	FHaybaMCPEditorState::FScopedPieOverride NoPie{ HaybaMCPState::FPieState{} };
	UHaybaMCPDeveloperSettings* Settings = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement SavedMode = Settings->LeaseEnforcement;
	ON_SCOPE_EXIT
	{
		Settings->LeaseEnforcement = SavedMode;
		// Safety net only: a refused editor_start_pie queues nothing.
		if (GEditor && GEditor->IsPlaySessionRequestQueued())
		{
			GEditor->CancelRequestPlaySession();
		}
	};

	const FString Tag = NewTag();
	const FString Builder = TEXT("hayba-test-") + Tag + TEXT("-builder");
	const FString Lane5 = TEXT("hayba-test-") + Tag + TEXT("-lane5");
	const FString Package = TEXT("/Game/__HaybaTest__/BP_Busy_") + Tag;

	// Each (caller, cmd, holder) logs at most one Warning per 30 s window, not one
	// per call. The limiter is process-wide, so the count is -1 (any number).
	AddExpectedMessagePlain(FString::Printf(TEXT("asset_busy: refused 'editor_start_pie' from '%s'"), *Lane5),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	AddExpectedMessagePlain(FString::Printf(TEXT("asset_busy: refused 'editor_start_pie' from '%s'"), *Builder),
		ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	{
		FScopedAssetLease Build(Builder, Package, TEXT("build:test"));
		if (!TestFalse(TEXT("builder holds the asset lease"), Build.Token.IsEmpty()))
		{
			return false;
		}

		for (const EHaybaMCPLeaseEnforcement Mode : { EHaybaMCPLeaseEnforcement::Advisory, EHaybaMCPLeaseEnforcement::Enforced })
		{
			Settings->LeaseEnforcement = Mode;
			// The builder's own editor_start_pie is refused too (R-23): the
			// caller's own build counts.
			for (const FString& Caller : { Lane5, Builder })
			{
				const FString What = FString::Printf(TEXT("[%s as %s]"),
					Mode == EHaybaMCPLeaseEnforcement::Advisory ? TEXT("advisory") : TEXT("enforced"), *Caller);
				const TSharedPtr<FJsonObject> Reply = Parse(Send(*Router, TEXT("editor_start_pie"), Caller, 900301, MakeShared<FJsonObject>()));
				if (!TestTrue(What + TEXT(" reply parses"), Reply.IsValid()))
				{
					continue;
				}
				TestFalse(What + TEXT(" is refused"), Reply->GetBoolField(TEXT("ok")));
				TestEqual(What + TEXT(" code"), StringOr(Reply, TEXT("code")), FString(TEXT("asset_busy")));
				TestTrue(What + TEXT(" message"), StringOr(Reply, TEXT("error")).StartsWith(TEXT("asset_busy: 'editor_start_pie' is refused: ")));
				const TSharedPtr<FJsonObject>* Busy = nullptr;
				if (TestTrue(What + TEXT(" busy detail"), Reply->TryGetObjectField(TEXT("busy"), Busy) && Busy))
				{
					TestEqual(What + TEXT(" busy.command"), StringOr(*Busy, TEXT("command")), FString(TEXT("editor_start_pie")));
					TestEqual(What + TEXT(" busy.caller_owner"), StringOr(*Busy, TEXT("caller_owner")), Caller);
				}
				const TSharedPtr<FJsonObject> First = FirstBusyAsset(Reply);
				if (TestTrue(What + TEXT(" busy.assets[0]"), First.IsValid()))
				{
					TestEqual(What + TEXT(" holder"), StringOr(First, TEXT("owner")), Builder);
					TestEqual(What + TEXT(" asset"), StringOr(First, TEXT("asset")), Package.ToLower());
					TestEqual(What + TEXT(" label"), StringOr(First, TEXT("label")), FString(TEXT("build:test")));
					TestEqual(What + TEXT(" lane"), StringOr(First, TEXT("lane")), FString(TEXT("long")));
					TestFalse(What + TEXT(" never a lease handle"), First->HasField(TEXT("lease_id")) || First->HasField(TEXT("token")));
				}
				ExpectRetryablePreflight(*this, What, Reply);
				TestFalse(What + TEXT(" no PIE request was queued"), GEditor->IsPlaySessionRequestQueued());
				TestNull(What + TEXT(" no play world"), GEditor->PlayWorld.Get());
			}
		}

		// Reads answer during a build, and building lists it without a handle.
		Settings->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Enforced;
		const TSharedRef<FJsonObject> StateParams = MakeShared<FJsonObject>();
		StateParams->SetBoolField(TEXT("include_dirty"), false);
		const TSharedPtr<FJsonObject> State = Parse(Send(*Router, TEXT("editor_get_state"), Lane5, 900302, StateParams));
		const TSharedPtr<FJsonObject>* Data = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Building = nullptr;
		if (TestTrue(TEXT("editor_get_state answers during a build"),
			State.IsValid() && State->GetBoolField(TEXT("ok")) && State->TryGetObjectField(TEXT("data"), Data) && Data
			&& (*Data)->TryGetArrayField(TEXT("building"), Building) && Building))
		{
			TSharedPtr<FJsonObject> Mine;
			for (const TSharedPtr<FJsonValue>& Item : *Building)
			{
				const TSharedPtr<FJsonObject> Obj = Item.IsValid() ? Item->AsObject() : nullptr;
				if (Obj.IsValid() && StringOr(Obj, TEXT("owner")) == Builder)
				{
					Mine = Obj;
				}
			}
			if (TestTrue(TEXT("building lists the builder's asset"), Mine.IsValid()))
			{
				TestEqual(TEXT("building names the asset"), StringOr(Mine, TEXT("asset")), Package.ToLower());
				TestEqual(TEXT("building names the label"), StringOr(Mine, TEXT("label")), FString(TEXT("build:test")));
				TestTrue(TEXT("building dates it"), Mine->HasField(TEXT("since")) && Mine->HasField(TEXT("held_s")) && Mine->HasField(TEXT("expires_in_s")));
				TestFalse(TEXT("building never carries a lease handle"), Mine->HasField(TEXT("lease_id")) || Mine->HasField(TEXT("token")));
			}
		}
	}

	// The build lease is released: building no longer lists it.
	const TArray<HaybaMCPState::FBusyAsset> After = FHaybaMCPEditorState::Get().BuildingAssets();
	TestFalse(TEXT("a released build is no longer busy"),
		After.ContainsByPredicate([&Builder](const HaybaMCPState::FBusyAsset& A) { return A.Owner == Builder; }));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FHaybaMCPStateRouterAssetBusyCompileTest,
	"Hayba.MCP.State.RouterAssetBusyCompile",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPStateRouterAssetBusyCompileTest::RunTest(const FString& Parameters)
{
	using namespace HaybaAssetBusyRouterTest;
	const TSharedPtr<FHaybaMCPCommandHandler> Router = RouterOrNull(*this);
	if (!TestTrue(TEXT("router exists"), Router.IsValid()))
	{
		return false;
	}

	FHaybaEditorHealth::FScopedOverrideForTests Health;
	FHaybaMCPEditorState::FScopedPieOverride NoPie{ HaybaMCPState::FPieState{} };
	UHaybaMCPDeveloperSettings* Settings = GetMutableDefault<UHaybaMCPDeveloperSettings>();
	const EHaybaMCPLeaseEnforcement SavedMode = Settings->LeaseEnforcement;
	ON_SCOPE_EXIT { Settings->LeaseEnforcement = SavedMode; };
	// The Advisory and Off runs dispatch to a handler that cannot find the test
	// asset, and the lease gate logs its own [advisory] line.
	AddExpectedMessagePlain(TEXT("Failed to find object"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	AddExpectedMessagePlain(TEXT("[advisory]"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);
	// The Enforced runs are refused at slot 3 and log through the gate limiter.
	AddExpectedMessagePlain(TEXT("asset_busy: refused '"), ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, -1);

	const FString Tag = NewTag();
	const FString Builder = TEXT("hayba-test-") + Tag + TEXT("-builder");
	const FString Lane5 = TEXT("hayba-test-") + Tag + TEXT("-lane5");
	const FString Package = TEXT("/Game/__HaybaTest__/BP_Compile_") + Tag;
	const FString ObjectPath = Package + TEXT(".BP_Compile_") + Tag;   // another spelling of the same asset
	FScopedAssetLease Build(Builder, Package, TEXT("build:test"));
	if (!TestFalse(TEXT("builder holds the asset lease"), Build.Token.IsEmpty()))
	{
		return false;
	}
	const TSharedRef<FJsonObject> CompileParams = MakeShared<FJsonObject>();
	CompileParams->SetStringField(TEXT("path"), ObjectPath);

	// Enforced: refused at slot 3. The lease gate (slot 4) would also object,
	// but asset_busy comes first (R10).
	Settings->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Enforced;
	{
		const TSharedPtr<FJsonObject> Reply = Parse(Send(*Router, TEXT("blueprint_compile"), Lane5, 900311, CompileParams));
		TestEqual(TEXT("[enforced] another owner's compile is asset_busy, not lease_conflict"),
			StringOr(Reply, TEXT("code")), FString(TEXT("asset_busy")));
		const TSharedPtr<FJsonObject> First = FirstBusyAsset(Reply);
		if (TestTrue(TEXT("[enforced] busy.assets[0]"), First.IsValid()))
		{
			TestEqual(TEXT("[enforced] holder"), StringOr(First, TEXT("owner")), Builder);
			TestEqual(TEXT("[enforced] the object path resolved to the package"), StringOr(First, TEXT("asset")), Package.ToLower());
		}
		ExpectRetryablePreflight(*this, TEXT("[enforced] blueprint_compile"), Reply);
	}
	{
		const TSharedRef<FJsonObject> FunctionParams = MakeShared<FJsonObject>();
		FunctionParams->SetStringField(TEXT("function_path"), Package);
		const TSharedPtr<FJsonObject> Reply = Parse(Send(*Router, TEXT("material_compile"), Lane5, 900312, FunctionParams));
		TestEqual(TEXT("[enforced] material_compile by function_path is asset_busy"), StringOr(Reply, TEXT("code")), FString(TEXT("asset_busy")));
	}
	// For targets, slot 3 excludes the caller: a build compiles its own assets.
	const TArray<FString> Keys = { TEXT("asset:") + Package.ToLower() };
	TestEqual(TEXT("the builder's own compile sees no other holder"), FHaybaMCPEditorState::Get().BusyAssetsFor(Keys, Builder).Num(), 0);
	TestEqual(TEXT("another caller sees the builder"), FHaybaMCPEditorState::Get().BusyAssetsFor(Keys, Lane5).Num(), 1);

	// Advisory: the command runs, and the reply carries state_warning.
	Settings->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Advisory;
	{
		const TSharedPtr<FJsonObject> Reply = Parse(Send(*Router, TEXT("blueprint_compile"), Lane5, 900313, CompileParams));
		TestNotEqual(TEXT("[advisory] not refused by slot 3"), StringOr(Reply, TEXT("code")), FString(TEXT("asset_busy")));
		const TSharedPtr<FJsonObject>* Warning = nullptr;
		if (TestTrue(TEXT("[advisory] state_warning is attached"), Reply.IsValid() && Reply->TryGetObjectField(TEXT("state_warning"), Warning) && Warning))
		{
			TestEqual(TEXT("[advisory] state_warning.code"), StringOr(*Warning, TEXT("code")), FString(TEXT("asset_busy")));
			TestEqual(TEXT("[advisory] state_warning names the holder"), StringOr(FirstBusyAsset(*Warning), TEXT("owner")), Builder);
		}
	}

	// Off: slot 3 does nothing.
	Settings->LeaseEnforcement = EHaybaMCPLeaseEnforcement::Off;
	{
		const TSharedPtr<FJsonObject> Reply = Parse(Send(*Router, TEXT("blueprint_compile"), Lane5, 900314, CompileParams));
		TestNotEqual(TEXT("[off] not refused by slot 3"), StringOr(Reply, TEXT("code")), FString(TEXT("asset_busy")));
		TestFalse(TEXT("[off] no state_warning"), Reply.IsValid() && Reply->HasField(TEXT("state_warning")));
	}
	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
