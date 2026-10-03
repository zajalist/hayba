#include "Misc/AutomationTest.h"
#include "HaybaMCPMetaSoundHandler.h"
#include "HaybaMCPSaveVerify.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/ScopeExit.h"
#include "ObjectTools.h"
#include "UObject/Package.h"

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPMetaSoundReadOnlyTest,
    "Hayba.MCP.MetaSound.Compile.ReadOnlyRefusesBeforeConform",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPMetaSoundReadOnlyTest::RunTest(const FString& Parameters)
{
    FHaybaMCPMetaSoundHandler Handler;
    const FString Name = FString::Printf(TEXT("MS_RO_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower());
    TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
    Create->SetStringField(TEXT("package_path"), TEXT("/Game/__HaybaTest__/ReadOnly"));
    Create->SetStringField(TEXT("name"), Name);
    const FHaybaHandlerResult Created = Handler.Handle(TEXT("metasound_create"), Create);
    FString Path;
    if (Created.bOk && Created.Data.IsValid()) Created.Data->TryGetStringField(TEXT("path"), Path);
    UObject* Asset = Path.IsEmpty() ? nullptr : LoadObject<UObject>(nullptr, *Path);
    if (!TestNotNull(TEXT("the test MetaSound exists"), Asset)) return false;
    const FString File = HaybaSaveVerify::PackageFilename(Asset->GetOutermost());
    IPlatformFile& PlatformFile = FPlatformFileManager::Get().GetPlatformFile();
    ON_SCOPE_EXIT
    {
        PlatformFile.SetReadOnly(*File, false);
        ObjectTools::DeleteSingleObject(Asset, /*bPerformReferenceCheck=*/false);
        IFileManager::Get().Delete(*File, false, true, true);
    };
    if (!TestTrue(TEXT("the test MetaSound reached disk"), HaybaSaveVerify::SaveAndVerify(Asset).DidReachDisk())) return false;
    PlatformFile.SetReadOnly(*File, true);
    const bool bDirtyBefore = Asset->GetOutermost()->IsDirty();

    TSharedPtr<FJsonObject> Compile = MakeShared<FJsonObject>();
    Compile->SetStringField(TEXT("metasound_path"), Path);
    Compile->SetBoolField(TEXT("save"), true);
    const FHaybaHandlerResult R = Handler.Handle(TEXT("metasound_compile"), Compile);
    TestTrue(FString::Printf(TEXT("the refusal is a structured Ok result, not Err (%s)"), *R.ErrorMessage), R.bOk && R.Data.IsValid());
    FString Code, Error, MutationStatus;
    if (R.Data.IsValid())
    {
        R.Data->TryGetStringField(TEXT("code"), Code);
        R.Data->TryGetStringField(TEXT("error"), Error);
        R.Data->TryGetStringField(TEXT("mutation_status"), MutationStatus);
    }
    TestEqual(TEXT("code is package_read_only"), Code, FString(TEXT("package_read_only")));
    TestTrue(TEXT("error names metasound_compile"), Error.StartsWith(TEXT("metasound_compile [package_read_only]: ")));
    TestEqual(TEXT("nothing started"), MutationStatus, FString(TEXT("not_started")));
    TestEqual(TEXT("nothing was conformed: the dirty flag did not change"), Asset->GetOutermost()->IsDirty(), bDirtyBefore);
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
