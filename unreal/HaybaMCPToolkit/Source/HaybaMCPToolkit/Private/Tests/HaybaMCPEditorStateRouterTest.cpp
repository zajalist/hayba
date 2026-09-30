#include "Misc/AutomationTest.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPEditorState.h"
#include "HaybaMCPEditorStatePolicy.h"
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

#endif // WITH_DEV_AUTOMATION_TESTS
