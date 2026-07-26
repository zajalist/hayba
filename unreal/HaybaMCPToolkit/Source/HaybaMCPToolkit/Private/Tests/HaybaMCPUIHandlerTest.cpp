#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "EditorAssetLibrary.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "WidgetBlueprint.h"
#include "handlers/HaybaMCPUIHandler.h"
#endif

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPUIWidgetGuidTest,
    "Hayba.MCP.UI.WidgetGuidRegistration",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPUIWidgetGuidTest::RunTest(const FString& Parameters)
{
#if WITH_EDITOR
    const FString AssetName = FString::Printf(TEXT("WBP_WidgetGuid_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
    const FString AssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *AssetName);

    FHaybaMCPUIHandler Handler;

    TSharedPtr<FJsonObject> CreateParams = MakeShared<FJsonObject>();
    CreateParams->SetStringField(TEXT("path"), PackagePath);
    CreateParams->SetStringField(TEXT("name"), AssetName);
    CreateParams->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
    const FHaybaHandlerResult CreateResult = Handler.Handle(TEXT("ui_create_widget"), CreateParams);
    TestTrue(TEXT("ui_create_widget succeeds"), CreateResult.bOk);

    FString ObjectPath;
    if (CreateResult.bOk && CreateResult.Data.IsValid())
    {
        CreateResult.Data->TryGetStringField(TEXT("path"), ObjectPath);
    }

    TSharedPtr<FJsonObject> AddParams = MakeShared<FJsonObject>();
    AddParams->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    AddParams->SetStringField(TEXT("child_class"), TEXT("Button"));
    AddParams->SetStringField(TEXT("name"), TEXT("TestButton"));
    const FHaybaHandlerResult AddResult = Handler.Handle(TEXT("ui_add_element"), AddParams);
    TestTrue(TEXT("ui_add_element succeeds"), AddResult.bOk);

    UWidgetBlueprint* WidgetBlueprint = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
    if (TestNotNull(TEXT("created widget blueprint loads"), WidgetBlueprint))
    {
        const FGuid* RootGuid = WidgetBlueprint->WidgetVariableNameToGuidMap.Find(TEXT("RootCanvas"));
        const FGuid* ButtonGuid = WidgetBlueprint->WidgetVariableNameToGuidMap.Find(TEXT("TestButton"));
        TestTrue(TEXT("root widget has a valid variable GUID"), RootGuid && RootGuid->IsValid());
        TestTrue(TEXT("added widget has a valid variable GUID"), ButtonGuid && ButtonGuid->IsValid());

        FKismetEditorUtilities::CompileBlueprint(WidgetBlueprint);
        TestEqual(TEXT("widget blueprint compiles successfully"), WidgetBlueprint->Status, BS_UpToDate);
    }

    TestTrue(TEXT("temporary widget blueprint is deleted"), UEditorAssetLibrary::DeleteAsset(AssetPath));
#endif
    return true;
}
