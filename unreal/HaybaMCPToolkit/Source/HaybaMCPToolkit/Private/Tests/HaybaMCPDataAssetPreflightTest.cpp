#include "Misc/AutomationTest.h"

#include "Engine/DataAsset.h"
#include "Misc/PackageName.h"
#include "Modules/ModuleManager.h"
#include "handlers/HaybaMCPDataAssetHandler.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPDataAssetCreatePreflightTest,
    "Hayba.MCP.DataAsset.CreatePreflight",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPDataAssetCreatePreflightTest::RunTest(const FString& Parameters)
{
    FHaybaMCPDataAssetHandler Handler;
    const FString ProbeFolder = TEXT("/Game/__HaybaNativeTests");
    const FString ProbeName = TEXT("DA_HCR_DATA_001_MustNotExist");
    const FString ProbePackage = ProbeFolder / ProbeName;

    const auto BaseParams = [&]()
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("path"), ProbeFolder);
        Params->SetStringField(TEXT("name"), ProbeName);
        Params->SetStringField(TEXT("class_name"), UDataAsset::StaticClass()->GetPathName());
        return Params;
    };

    TestFalse(TEXT("the refusal probe must not already exist on disk"),
        FPackageName::DoesPackageExist(ProbePackage));

    // Every case below must return before ResolveClass, AssetTools, or package
    // mutation. The module-state assertion catches an accidental eager module
    // load when the test starts before AssetTools; the source-order contract
    // covers the same boundary when another editor subsystem loaded it first.
    const auto RefuseLexically = [&](const FString& Label, const TSharedPtr<FJsonObject>& Params)
    {
        const bool bAssetToolsLoadedBefore =
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("data_create"), Params);
        TestFalse(Label + TEXT(" is rejected"), Result.bOk);
        TestEqual(Label + TEXT(" does not load AssetTools"),
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools")),
            bAssetToolsLoadedBefore);
        TestTrue(Label + TEXT(" names data_create"),
            Result.ErrorMessage.Contains(TEXT("data_create")));
        TestFalse(Label + TEXT(" does not create the package"),
            FPackageName::DoesPackageExist(ProbePackage));
    };

    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), TEXT("/Game/") + FString::ChrN(1100, TEXT('P')));
        RefuseLexically(TEXT("oversized path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), TEXT("/Game/Folder.Asset"));
        RefuseLexically(TEXT("object path passed as a folder"), Params);
    }
    {
        FString EmbeddedNulPath = TEXT("/Game/Bad");
        EmbeddedNulPath.AppendChar(TEXT('\0'));
        EmbeddedNulPath += TEXT("Folder");
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("path"), EmbeddedNulPath);
        RefuseLexically(TEXT("embedded NUL in path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), FString::ChrN(300, TEXT('N')));
        RefuseLexically(TEXT("oversized name"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), TEXT("Bad\nName"));
        RefuseLexically(TEXT("control character in name"), Params);
    }
    {
        FString EmbeddedNul = TEXT("Bad");
        EmbeddedNul.AppendChar(TEXT('\0'));
        EmbeddedNul += TEXT("Name");
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("name"), EmbeddedNul);
        RefuseLexically(TEXT("embedded NUL in name"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), FString::ChrN(1100, TEXT('C')));
        RefuseLexically(TEXT("oversized class reference"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), TEXT("/Script/Engine.\tDataAsset"));
        RefuseLexically(TEXT("control character in class reference"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetStringField(TEXT("class_name"), TEXT("/Script/Engine.DataAsset.Extra"));
        RefuseLexically(TEXT("malformed class object path"), Params);
    }
    {
        TSharedPtr<FJsonObject> Params = BaseParams();
        Params->SetNumberField(TEXT("name"), 42.0);
        RefuseLexically(TEXT("wrong-typed name"), Params);
    }

    // UDataAsset itself is abstract. It resolves successfully, then must be
    // refused before the module load and CreateAsset boundary that produced
    // the observed HCR-DATA-001 crash signature.
    {
        const bool bAssetToolsLoadedBefore =
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools"));
        const FHaybaHandlerResult Result = Handler.Handle(TEXT("data_create"), BaseParams());
        TestFalse(TEXT("abstract UDataAsset is rejected"), Result.bOk);
        TestTrue(TEXT("abstract refusal explains the concrete-class requirement"),
            Result.ErrorMessage.Contains(TEXT("concrete UDataAsset subclass")));
        TestEqual(TEXT("abstract refusal does not load AssetTools"),
            FModuleManager::Get().IsModuleLoaded(TEXT("AssetTools")),
            bAssetToolsLoadedBefore);
        TestFalse(TEXT("abstract refusal creates no package"),
            FPackageName::DoesPackageExist(ProbePackage));
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
