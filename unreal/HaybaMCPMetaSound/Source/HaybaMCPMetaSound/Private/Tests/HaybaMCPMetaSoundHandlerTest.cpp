#include "Misc/AutomationTest.h"
#include "HaybaMCPMetaSoundHandler.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPMetaSoundInputBoundaryTest,
    "Hayba.MCP.MetaSound.InputBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPMetaSoundInputBoundaryTest::RunTest(const FString& Parameters)
{
    TestTrue(TEXT("MetaSound handler tests run on the editor game thread"), IsInGameThread());

    FHaybaMCPMetaSoundHandler Handler;
    const TArray<FString> Commands = Handler.GetCommands();
    for (const TCHAR* Command : {
        TEXT("metasound_create"), TEXT("metasound_add_node"),
        TEXT("metasound_connect"), TEXT("metasound_set_input"),
        TEXT("metasound_compile"), TEXT("metasound_inspect"),
        TEXT("metasound_list") })
    {
        TestTrue(FString::Printf(TEXT("%s is registered"), Command), Commands.Contains(Command));
    }

    {
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_create"), nullptr);
        TestFalse(TEXT("create rejects missing params"), Result.bOk);
        TestTrue(TEXT("create explains the missing object"), Result.ErrorMessage.Contains(TEXT("missing params")));
    }

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("package_path"), TEXT("/Engine/HaybaProbe"));
        Params->SetStringField(TEXT("name"), TEXT("MS_HaybaProbe"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_create"), Params);
        TestFalse(TEXT("create cannot write mounted engine content"), Result.bOk);
        TestTrue(TEXT("create points callers at project content"), Result.ErrorMessage.Contains(TEXT("/Game")));
    }

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetNumberField(TEXT("path_prefix"), 7.0);
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_list"), Params);
        TestFalse(TEXT("list rejects a non-string optional path"), Result.bOk);
        TestTrue(TEXT("list names the malformed field"), Result.ErrorMessage.Contains(TEXT("path_prefix")));
    }

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path_prefix"), TEXT("/Engine"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_list"), Params);
        TestFalse(TEXT("list cannot scan mounted engine content"), Result.bOk);
        TestTrue(TEXT("list states its project-content boundary"), Result.ErrorMessage.Contains(TEXT("/Game")));
    }

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("save"), TEXT("yes"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_compile"), Params);
        TestFalse(TEXT("compile rejects a non-boolean save flag"), Result.bOk);
        TestTrue(TEXT("save is validated before any asset is loaded"), Result.ErrorMessage.Contains(TEXT("save must be a boolean")));
    }

    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetNumberField(TEXT("metasound_path"), 7.0);
        Params->SetStringField(TEXT("path"), TEXT("/Game/WouldOtherwiseMaskTheBadCanonicalField"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("metasound_inspect"), Params);
        TestFalse(TEXT("a malformed canonical path cannot fall through to an alias"), Result.bOk);
        TestTrue(TEXT("the canonical field is named"), Result.ErrorMessage.Contains(TEXT("metasound_path")));
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
