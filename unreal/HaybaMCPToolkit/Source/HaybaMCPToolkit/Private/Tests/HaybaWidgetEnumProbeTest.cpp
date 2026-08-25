// Diagnostic: after ui_mutate_tree replace, what still gets enumerated?
//
// Hayba.MCP.UI.Replace.PreservesChildrenAndRollsBackCollision fails on an
// engine ensure:
//
//   Ensure condition failed:
//     WidgetBP->WidgetVariableNameToGuidMap.Contains(Widget->GetFName())
//   Widget [HaybaMCP_Replaced_0] was added but did not get a GUID
//
// The ensure lives inside WidgetBlueprint::ForEachSourceWidget. `replace`
// renames the outgoing widget to a scratch name, moves its GUID to the
// replacement, and calls WidgetTree->RemoveWidget on it -- so the question is
// why a removed widget is still visited. Three fixes were attempted and
// reverted on guesses; this asks the engine instead.
//
// Reports via warnings: test_get_log surfaces those, not AddInfo.
// Delete once the question is settled.

#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "Blueprint/WidgetTree.h"
#include "Components/Button.h"
#include "Components/CanvasPanel.h"
#include "EditorAssetLibrary.h"
#include "WidgetBlueprint.h"
#include "handlers/HaybaMCPUIHandler.h"
#endif

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaWidgetEnumProbeTest,
    "Hayba.Probe.WidgetEnumerationAfterReplace",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWidgetEnumProbeTest::RunTest(const FString&)
{
#if WITH_EDITOR
    const FString AssetName = FString::Printf(
        TEXT("WBP_EnumProbe_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
    const FString AssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *AssetName);

    FHaybaMCPUIHandler Handler;

    TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
    Create->SetStringField(TEXT("path"), PackagePath);
    Create->SetStringField(TEXT("name"), AssetName);
    Create->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
    const FHaybaHandlerResult CreateResult = Handler.Handle(TEXT("ui_create_widget"), Create);
    AddWarning(FString::Printf(TEXT("ui_create_widget ok=%s"), CreateResult.bOk ? TEXT("true") : TEXT("false")));
    if (!CreateResult.bOk) return true;

    UWidgetBlueprint* WBP = Cast<UWidgetBlueprint>(
        UEditorAssetLibrary::LoadAsset(AssetPath));
    if (!WBP || !WBP->WidgetTree)
    {
        AddWarning(TEXT("could not load the probe blueprint"));
        return true;
    }

    // Root panel + one child to replace.
    UCanvasPanel* Root = WBP->WidgetTree->ConstructWidget<UCanvasPanel>(
        UCanvasPanel::StaticClass(), TEXT("RootCanvas"));
    WBP->WidgetTree->RootWidget = Root;
    UButton* Target = WBP->WidgetTree->ConstructWidget<UButton>(
        UButton::StaticClass(), TEXT("ProbeTarget"));
    Root->AddChild(Target);
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("RootCanvas"), FGuid::NewGuid());
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("ProbeTarget"), FGuid::NewGuid());

    TSharedPtr<FJsonObject> Replace = MakeShared<FJsonObject>();
    Replace->SetStringField(TEXT("widget_blueprint_path"), AssetPath);
    Replace->SetStringField(TEXT("operation"), TEXT("replace"));
    Replace->SetStringField(TEXT("widget_name"), TEXT("ProbeTarget"));
    Replace->SetStringField(TEXT("new_class"), TEXT("Border"));
    Replace->SetBoolField(TEXT("preserve_guid"), true);
    const FHaybaHandlerResult R = Handler.Handle(TEXT("ui_mutate_tree"), Replace);
    AddWarning(FString::Printf(TEXT("replace ok=%s err='%s'"),
        R.bOk ? TEXT("true") : TEXT("false"), *R.ErrorMessage));

    // 1. What the TREE walk sees (root-relative).
    {
        TArray<UWidget*> All;
        WBP->WidgetTree->GetAllWidgets(All);
        FString Names;
        for (const UWidget* W : All) if (W) Names += W->GetName() + TEXT(" ");
        AddWarning(FString::Printf(TEXT("WidgetTree->GetAllWidgets: %s"), *Names));
    }

    // 2. What is still OUTERED to the tree, attached or not. If the scratch
    //    widget shows up here but not above, RemoveWidget detached it without
    //    reparenting, and the enumeration reaches it by ownership.
    {
        TArray<UObject*> Owned;
        GetObjectsWithOuter(WBP->WidgetTree, Owned, /*bIncludeNestedObjects*/ false);
        FString Names;
        for (const UObject* O : Owned)
        {
            if (const UWidget* W = Cast<UWidget>(O)) Names += W->GetName() + TEXT(" ");
        }
        AddWarning(FString::Printf(TEXT("GetObjectsWithOuter(WidgetTree): %s"), *Names));
    }

    // 3. Which of those lack a GUID -- i.e. what the compiler would ensure on.
    {
        TArray<UObject*> Owned;
        GetObjectsWithOuter(WBP->WidgetTree, Owned, false);
        FString Missing;
        for (const UObject* O : Owned)
        {
            const UWidget* W = Cast<UWidget>(O);
            if (!W) continue;
            if (!WBP->WidgetVariableNameToGuidMap.Contains(W->GetFName()))
            {
                Missing += FString::Printf(TEXT("%s(bIsVariable=%s) "),
                    *W->GetName(), W->bIsVariable ? TEXT("true") : TEXT("false"));
            }
        }
        AddWarning(FString::Printf(TEXT("owned widgets with NO guid: %s"),
            Missing.IsEmpty() ? TEXT("<none>") : *Missing));
    }

    UEditorAssetLibrary::DeleteAsset(AssetPath);
#endif
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
