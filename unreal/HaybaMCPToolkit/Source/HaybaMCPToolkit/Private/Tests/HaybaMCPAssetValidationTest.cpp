#include "Misc/AutomationTest.h"
#include "HaybaMCPAssetValidation.h"
#include "handlers/HaybaMCPAssetHandler.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Editor.h"
#include "Curves/CurveFloat.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Misc/ScopeExit.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAssetValidationCoverageTest,
    "Hayba.MCP.AssetValidation.Coverage", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetValidationCoverageTest::RunTest(const FString& Parameters)
{
    auto Check = [this](const TCHAR* Label, const FValidateAssetsResults& Results, const TCHAR* Status, bool bValid, bool bComplete)
    {
        const auto Summary = HaybaAssetValidation::Summarize(Results);
        TestEqual(FString(Label) + TEXT(" status"), Summary->GetStringField(TEXT("status")), FString(Status));
        TestEqual(FString(Label) + TEXT(" valid"), Summary->GetBoolField(TEXT("valid")), bValid);
        TestEqual(FString(Label) + TEXT(" complete"), Summary->GetBoolField(TEXT("complete")), bComplete);
    };
    FValidateAssetsResults Results;
    Check(TEXT("empty"), Results, TEXT("not_validated"), false, false);
    Results.NumRequested = 2;
    Results.NumSkipped = 2;
    Check(TEXT("all skipped"), Results, TEXT("not_validated"), false, false);
    Results.NumSkipped = 0;
    Results.NumChecked = 2;
    Results.NumUnableToValidate = 2;
    Check(TEXT("no validators"), Results, TEXT("not_validated"), false, false);
    Results.NumUnableToValidate = 1;
    Results.NumValid = 1;
    Check(TEXT("partial coverage"), Results, TEXT("partial"), false, false);
    Results.NumUnableToValidate = 0;
    Results.NumChecked = 1;
    Results.bAssetLimitReached = true;
    Check(TEXT("budget exhausted"), Results, TEXT("partial"), false, false);
    Results.NumChecked = 2;
    Results.NumValid = 2;
    Check(TEXT("exact budget covered"), Results, TEXT("passed"), true, true);
    Results.NumWarnings = 1;
    Check(TEXT("warnings do not erase coverage"), Results, TEXT("passed"), true, true);
    Results.bWasCancelled = true;
    Check(TEXT("cancelled"), Results, TEXT("cancelled"), false, false);
    Results.bWasCancelled = false;
    Results.NumValid = 1;
    Results.NumInvalid = 1;
    Check(TEXT("invalid"), Results, TEXT("failed"), false, true);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAssetValidationBudgetTest,
    "Hayba.MCP.AssetValidation.Budget", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetValidationBudgetTest::RunTest(const FString& Parameters)
{
    FHaybaMCPAssetHandler Handler;
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("path"), TEXT("/Game/__HaybaMissingValidationProbe"));
    for (const double Budget : {0.0, -1.0, 1.5, 1001.0})
    {
        Params->SetNumberField(TEXT("max_assets"), Budget);
        const auto Result = Handler.Handle(TEXT("asset_validate"), Params);
        TestFalse(TEXT("invalid budget refused"), Result.bOk);
        TestTrue(TEXT("budget refusal precedes lookup"), Result.ErrorMessage.Contains(TEXT("max_assets")));
    }
    Params->SetStringField(TEXT("max_assets"), TEXT("100"));
    const auto Result = Handler.Handle(TEXT("asset_validate"), Params);
    TestFalse(TEXT("string budget refused"), Result.bOk);
    TestTrue(TEXT("string budget diagnosed"), Result.ErrorMessage.Contains(TEXT("max_assets")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAssetValidationRuntimeTest,
    "Hayba.MCP.AssetValidation.Runtime", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAssetValidationRuntimeTest::RunTest(const FString& Parameters)
{
    if (!TestNotNull(TEXT("editor available"), GEditor)) return false;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!TestNotNull(TEXT("disposable editor world available"), World)) return false;
    const bool bWorldDirty = World->GetPackage()->IsDirty();
    IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    const FString Root = TEXT("/Game/__HaybaValidationRuntime_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    TArray<TStrongObjectPtr<UObject>> Assets;
    ON_SCOPE_EXIT
    {
        for (const auto& Asset : Assets)
        {
            FAssetRegistryModule::AssetDeleted(Asset.Get());
            Asset->ClearFlags(RF_Public | RF_Standalone);
            Asset->GetPackage()->SetDirtyFlag(false);
        }
    };
    for (const TCHAR* Name : { TEXT("One"), TEXT("Two") })
    {
        UPackage* Package = CreatePackage(*(Root / Name));
        UObject* Asset = NewObject<UCurveFloat>(Package, FName(Name), RF_Public | RF_Standalone);
        Assets.Emplace(Asset);
        FAssetRegistryModule::AssetCreated(Asset);
        Package->SetDirtyFlag(false);
        if (!TestTrue(TEXT("fixture registered without saving"), Registry.GetAssetByObjectPath(FSoftObjectPath(Asset)).IsValid())) return false;
        TestFalse(TEXT("fixture package has no disk file"), IFileManager::Get().FileExists(
            *FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetAssetPackageExtension())));
    }
    FHaybaMCPAssetHandler Handler;
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("path"), Root);
    Params->SetNumberField(TEXT("max_assets"), 1);
    const auto Overflow = Handler.Handle(TEXT("asset_validate"), Params);
    TestFalse(TEXT("two-asset folder refused before validation at budget one"), Overflow.bOk);
    TestTrue(TEXT("refusal explicitly confirms no assets validated"), Overflow.ErrorMessage.Contains(TEXT("folder exceeds max_assets=1; nothing was validated")));

    Params->SetStringField(TEXT("path"), Assets[0]->GetPathName());
    const auto Validated = Handler.Handle(TEXT("asset_validate"), Params);
    if (TestTrue(TEXT("concrete curve fixture returns a validation summary"), Validated.bOk) &&
        TestTrue(TEXT("validation summary present"), Validated.Data.IsValid()))
    {
        TestEqual(TEXT("curve validation passed"), Validated.Data->GetStringField(TEXT("status")), FString(TEXT("passed")));
        TestTrue(TEXT("curve is valid"), Validated.Data->GetBoolField(TEXT("valid")));
        TestTrue(TEXT("curve has complete coverage"), Validated.Data->GetBoolField(TEXT("complete")));
        TestEqual(TEXT("one curve requested"), Validated.Data->GetNumberField(TEXT("num_requested")), 1.0);
        TestEqual(TEXT("one curve checked"), Validated.Data->GetNumberField(TEXT("num_checked")), 1.0);
        TestEqual(TEXT("one curve validated"), Validated.Data->GetNumberField(TEXT("num_valid")), 1.0);
    }
    for (const auto& Asset : Assets)
    {
        TestFalse(TEXT("validation leaves fixture package clean"), Asset->GetPackage()->IsDirty());
        TestFalse(TEXT("validation did not save fixture"), IFileManager::Get().FileExists(
            *FPackageName::LongPackageNameToFilename(Asset->GetPackage()->GetName(), FPackageName::GetAssetPackageExtension())));
    }
    TestEqual(TEXT("validation preserves editor-world dirty state"), World->GetPackage()->IsDirty(), bWorldDirty);
    return true;
}
#endif
