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
#include "Editor/EditorEngine.h"
#include "Features/IModularFeatures.h"
#include "IPIEAuthorizer.h"
#include "Misc/Guid.h"
#include "Misc/ScopeExit.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

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

#endif // WITH_DEV_AUTOMATION_TESTS
