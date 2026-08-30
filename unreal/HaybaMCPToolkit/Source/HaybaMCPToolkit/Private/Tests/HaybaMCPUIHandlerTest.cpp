#include "Misc/AutomationTest.h"

#if WITH_EDITOR
#include "EditorAssetLibrary.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Button.h"
#include "Components/ButtonSlot.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/Overlay.h"
#include "Components/TextBlock.h"
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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPUIReplacePreservesChildrenTest,
    "Hayba.MCP.UI.Replace.PreservesChildrenAndRollsBackCollision",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPUIReplacePreservesChildrenTest::RunTest(const FString& Parameters)
{
#if WITH_EDITOR
    const FString AssetName = FString::Printf(TEXT("WBP_ReplaceChildren_%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits));
    const FString PackagePath = TEXT("/Game/HaybaMCPAutomation");
    const FString AssetPath = FString::Printf(TEXT("%s/%s"), *PackagePath, *AssetName);

    FHaybaMCPUIHandler Handler;
    TSharedPtr<FJsonObject> Create = MakeShared<FJsonObject>();
    Create->SetStringField(TEXT("path"), PackagePath);
    Create->SetStringField(TEXT("name"), AssetName);
    Create->SetStringField(TEXT("parent_class"), TEXT("UserWidget"));
    const FHaybaHandlerResult Created = Handler.Handle(TEXT("ui_create_widget"), Create);
    TestTrue(TEXT("test widget blueprint is created"), Created.bOk);

    FString ObjectPath;
    if (Created.bOk && Created.Data.IsValid()) Created.Data->TryGetStringField(TEXT("path"), ObjectPath);
    UWidgetBlueprint* WBP = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath);
    if (!TestNotNull(TEXT("test widget blueprint loads"), WBP) || !WBP->WidgetTree)
    {
        UEditorAssetLibrary::DeleteAsset(AssetPath);
        return false;
    }

    UCanvasPanel* Root = CastChecked<UCanvasPanel>(WBP->WidgetTree->RootWidget);
    UButton* Original = WBP->WidgetTree->ConstructWidget<UButton>(UButton::StaticClass(), TEXT("ActionButton"));
    UOverlay* Overlay = WBP->WidgetTree->ConstructWidget<UOverlay>(UOverlay::StaticClass(), TEXT("ActionVisual"));
    UTextBlock* Label = WBP->WidgetTree->ConstructWidget<UTextBlock>(UTextBlock::StaticClass(), TEXT("ActionLabel"));
    UButton* Collision = WBP->WidgetTree->ConstructWidget<UButton>(UButton::StaticClass(), TEXT("CollisionTarget"));

    UCanvasPanelSlot* OriginalRootSlot = CastChecked<UCanvasPanelSlot>(Root->AddChild(Original));
    OriginalRootSlot->SetPosition(FVector2D(123.0, 456.0));
    UButtonSlot* OriginalChildSlot = CastChecked<UButtonSlot>(Original->AddChild(Overlay));
    OriginalChildSlot->SetPadding(FMargin(3.0, 5.0, 7.0, 11.0));
    Overlay->AddChild(Label);
    Root->AddChild(Collision);
    Original->SetIsEnabled(false);
    Label->SetText(FText::FromString(TEXT("Preserve me")));

    const FGuid OriginalGuid = FGuid::NewGuid();
    const FGuid OverlayGuid = FGuid::NewGuid();
    const FGuid LabelGuid = FGuid::NewGuid();
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("ActionButton"), OriginalGuid);
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("ActionVisual"), OverlayGuid);
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("ActionLabel"), LabelGuid);

    TSharedPtr<FJsonObject> Replace = MakeShared<FJsonObject>();
    Replace->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    Replace->SetStringField(TEXT("operation"), TEXT("replace"));
    Replace->SetStringField(TEXT("widget_name"), TEXT("ActionButton"));
    Replace->SetStringField(TEXT("new_class"), TEXT("Button"));
    Replace->SetBoolField(TEXT("preserve_guid"), true);
    Replace->SetBoolField(TEXT("preserve_properties"), true);
    // Intentionally omit preserve_children: the safe default is the contract.
    const FHaybaHandlerResult Replaced = Handler.Handle(TEXT("ui_mutate_tree"), Replace);
    TestTrue(TEXT("replacement succeeds"), Replaced.bOk);

    UButton* Replacement = WBP->WidgetTree->FindWidget<UButton>(TEXT("ActionButton"));
    TestNotNull(TEXT("replacement retains the source name"), Replacement);
    TestTrue(TEXT("replacement is a distinct widget"), Replacement && Replacement != Original);
    TestTrue(TEXT("shared property is preserved"), Replacement && !Replacement->GetIsEnabled());
    TestTrue(TEXT("nested overlay object is preserved, not cloned"), Replacement && Replacement->GetChildAt(0) == Overlay);
    TestTrue(TEXT("nested text object remains below the overlay"), Overlay->GetChildAt(0) == Label);
    TestEqual(TEXT("nested label name is unchanged"), Label->GetName(), FString(TEXT("ActionLabel")));
    TestEqual(TEXT("nested label text is unchanged"), Label->GetText().ToString(), FString(TEXT("Preserve me")));
    TestTrue(TEXT("parent slot object is preserved"), Replacement && Replacement->Slot == OriginalRootSlot);
    TestEqual(TEXT("parent slot position is preserved"), OriginalRootSlot->GetPosition(), FVector2D(123.0, 456.0));
    UButtonSlot* ReplacementChildSlot = Replacement ? Cast<UButtonSlot>(Overlay->Slot) : nullptr;
    TestNotNull(TEXT("replacement child has the expected slot class"), ReplacementChildSlot);
    TestEqual(TEXT("replacement child slot padding is preserved"),
        ReplacementChildSlot ? ReplacementChildSlot->GetPadding() : FMargin(), FMargin(3.0, 5.0, 7.0, 11.0));
    TestEqual(TEXT("source variable GUID is preserved"),
        WBP->WidgetVariableNameToGuidMap.FindRef(TEXT("ActionButton")), OriginalGuid);
    TestEqual(TEXT("overlay variable GUID is preserved"),
        WBP->WidgetVariableNameToGuidMap.FindRef(TEXT("ActionVisual")), OverlayGuid);
    TestEqual(TEXT("label variable GUID is preserved"),
        WBP->WidgetVariableNameToGuidMap.FindRef(TEXT("ActionLabel")), LabelGuid);
    if (Replaced.Data.IsValid())
    {
        TestEqual(TEXT("response reports the preserved direct child"),
            static_cast<int32>(Replaced.Data->GetNumberField(TEXT("children_preserved"))), 1);
    }

    // A colliding requested name is a hard preflight error.  It must not rename
    // the source, move its child, change its slot, or alter either GUID.
    TSharedPtr<FJsonObject> CollidingReplace = MakeShared<FJsonObject>();
    CollidingReplace->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    CollidingReplace->SetStringField(TEXT("operation"), TEXT("replace"));
    CollidingReplace->SetStringField(TEXT("widget_name"), TEXT("ActionButton"));
    CollidingReplace->SetStringField(TEXT("new_class"), TEXT("Button"));
    CollidingReplace->SetStringField(TEXT("new_name"), TEXT("CollisionTarget"));
    const FHaybaHandlerResult CollisionResult = Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace);
    TestFalse(TEXT("name collision is rejected"), CollisionResult.bOk);
    TestTrue(TEXT("source survives collision unchanged"), WBP->WidgetTree->FindWidget(TEXT("ActionButton")) == Replacement);
    TestTrue(TEXT("colliding widget survives unchanged"), WBP->WidgetTree->FindWidget(TEXT("CollisionTarget")) == Collision);
    TestTrue(TEXT("child remains attached after collision"), Replacement && Replacement->GetChildAt(0) == Overlay);
    TestTrue(TEXT("parent slot remains unchanged after collision"), Replacement && Replacement->Slot == OriginalRootSlot);
    TestEqual(TEXT("source GUID remains unchanged after collision"),
        WBP->WidgetVariableNameToGuidMap.FindRef(TEXT("ActionButton")), OriginalGuid);

    CollidingReplace->SetStringField(TEXT("new_name"), TEXT("collisiontarget"));
    TestFalse(TEXT("case-insensitive UObject name collision is rejected"),
        Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace).bOk);
    CollidingReplace->SetStringField(TEXT("new_name"), TEXT("actionbutton"));
    TestFalse(TEXT("case-only rename is rejected without mutation"),
        Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace).bOk);
    CollidingReplace->SetStringField(TEXT("new_name"), TEXT("None"));
    TestFalse(TEXT("NAME_None replacement name is rejected"),
        Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace).bOk);
    CollidingReplace->SetStringField(TEXT("new_name"), TEXT("Bad/Name"));
    TestFalse(TEXT("invalid UObject replacement name is rejected"),
        Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace).bOk);
    TestTrue(TEXT("source remains unchanged after invalid names"),
        WBP->WidgetTree->FindWidget(TEXT("ActionButton")) == Replacement && Replacement->GetChildAt(0) == Overlay);
    CollidingReplace->SetNumberField(TEXT("new_name"), 42);
    TestFalse(TEXT("direct-native non-string new_name is rejected"),
        Handler.Handle(TEXT("ui_mutate_tree"), CollidingReplace).bOk);

    TSharedPtr<FJsonObject> WrongType = MakeShared<FJsonObject>();
    WrongType->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    WrongType->SetStringField(TEXT("operation"), TEXT("replace"));
    WrongType->SetStringField(TEXT("widget_name"), TEXT("ActionButton"));
    WrongType->SetStringField(TEXT("new_class"), TEXT("Button"));
    WrongType->SetStringField(TEXT("preserve_children"), TEXT("true"));
    TestFalse(TEXT("direct-native string preserve_children is rejected"),
        Handler.Handle(TEXT("ui_mutate_tree"), WrongType).bOk);

    UButton* Disposable = WBP->WidgetTree->ConstructWidget<UButton>(UButton::StaticClass(), TEXT("Disposable"));
    UOverlay* DisposableVisual = WBP->WidgetTree->ConstructWidget<UOverlay>(UOverlay::StaticClass(), TEXT("DisposableVisual"));
    UTextBlock* DisposableLabel = WBP->WidgetTree->ConstructWidget<UTextBlock>(UTextBlock::StaticClass(), TEXT("DisposableLabel"));
    Root->AddChild(Disposable);
    Disposable->AddChild(DisposableVisual);
    DisposableVisual->AddChild(DisposableLabel);
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("Disposable"), FGuid::NewGuid());
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("DisposableVisual"), FGuid::NewGuid());
    WBP->WidgetVariableNameToGuidMap.Add(TEXT("DisposableLabel"), FGuid::NewGuid());
    TSharedPtr<FJsonObject> DestructiveReplace = MakeShared<FJsonObject>();
    DestructiveReplace->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    DestructiveReplace->SetStringField(TEXT("operation"), TEXT("replace"));
    DestructiveReplace->SetStringField(TEXT("widget_name"), TEXT("Disposable"));
    DestructiveReplace->SetStringField(TEXT("new_class"), TEXT("TextBlock"));
    DestructiveReplace->SetBoolField(TEXT("preserve_children"), false);
    const FHaybaHandlerResult DestructiveResult = Handler.Handle(TEXT("ui_mutate_tree"), DestructiveReplace);
    TestTrue(TEXT("explicit destructive replacement succeeds"), DestructiveResult.bOk);
    UTextBlock* DisposableReplacement = WBP->WidgetTree->FindWidget<UTextBlock>(TEXT("Disposable"));
    TestTrue(TEXT("destructive replacement permits a non-panel target and creates a fresh widget"),
        DisposableReplacement && static_cast<UWidget*>(DisposableReplacement) != static_cast<UWidget*>(Disposable));
    TestNull(TEXT("discarded direct child is absent from the live tree"),
        WBP->WidgetTree->FindWidget(TEXT("DisposableVisual")));
    TestNull(TEXT("discarded nested child is absent from the live tree"),
        WBP->WidgetTree->FindWidget(TEXT("DisposableLabel")));
    TestFalse(TEXT("discarded direct child GUID is removed"),
        WBP->WidgetVariableNameToGuidMap.Contains(TEXT("DisposableVisual")));
    TestFalse(TEXT("discarded nested child GUID is removed"),
        WBP->WidgetVariableNameToGuidMap.Contains(TEXT("DisposableLabel")));
    UOverlay* ReusedVisualName = WBP->WidgetTree->ConstructWidget<UOverlay>(UOverlay::StaticClass(), TEXT("DisposableVisual"));
    UTextBlock* ReusedLabelName = WBP->WidgetTree->ConstructWidget<UTextBlock>(UTextBlock::StaticClass(), TEXT("DisposableLabel"));
    TestEqual(TEXT("discarded direct child name can be reused exactly"),
        ReusedVisualName->GetFName(), FName(TEXT("DisposableVisual")));
    TestEqual(TEXT("discarded nested child name can be reused exactly"),
        ReusedLabelName->GetFName(), FName(TEXT("DisposableLabel")));
    Root->AddChild(ReusedVisualName);
    ReusedVisualName->AddChild(ReusedLabelName);
    if (DestructiveResult.Data.IsValid())
    {
        TestEqual(TEXT("destructive response reports no preserved direct children"),
            static_cast<int32>(DestructiveResult.Data->GetNumberField(TEXT("children_preserved"))), 0);
        TestEqual(TEXT("destructive response reports no preserved descendants"),
            static_cast<int32>(DestructiveResult.Data->GetNumberField(TEXT("descendants_preserved"))), 0);
        TestFalse(TEXT("destructive response echoes the opt-out"),
            DestructiveResult.Data->GetBoolField(TEXT("preserve_children")));
    }

    // LetterSpacing is a member of FSlateFontInfo, not UTextBlock.  Verify the
    // nested reflective patch lands and does not reset the rest of the font.
    UTextBlock* TrackingText = WBP->WidgetTree->ConstructWidget<UTextBlock>(UTextBlock::StaticClass(), TEXT("TrackingText"));
    Root->AddChild(TrackingText);
    FSlateFontInfo InitialFont = TrackingText->GetFont();
    InitialFont.Size = 37;
    TrackingText->SetFont(InitialFont);
    TSharedPtr<FJsonObject> FontPatch = MakeShared<FJsonObject>();
    FontPatch->SetNumberField(TEXT("LetterSpacing"), 125);
    TSharedPtr<FJsonObject> TextProperties = MakeShared<FJsonObject>();
    TextProperties->SetObjectField(TEXT("Font"), FontPatch);
    TSharedPtr<FJsonObject> SetTextStyle = MakeShared<FJsonObject>();
    SetTextStyle->SetStringField(TEXT("widget_blueprint_path"), ObjectPath);
    SetTextStyle->SetStringField(TEXT("widget_name"), TEXT("TrackingText"));
    SetTextStyle->SetObjectField(TEXT("properties"), TextProperties);
    const FHaybaHandlerResult TextStyleResult = Handler.Handle(TEXT("ui_set_widget_properties"), SetTextStyle);
    TestTrue(TEXT("nested Font.LetterSpacing patch succeeds"), TextStyleResult.bOk);
    TestEqual(TEXT("nested Font.LetterSpacing lands on FSlateFontInfo"), TrackingText->GetFont().LetterSpacing, 125);
    TestEqual(TEXT("partial font patch preserves existing size"), TrackingText->GetFont().Size, 37.0f);

    int32 ScratchSourceCount = 0;
    int32 MissingSourceGuidCount = 0;
    WBP->ForEachSourceWidget([&](UWidget* SourceWidget)
    {
        if (!SourceWidget) return;
        const FString SourceName = SourceWidget->GetName();
        if (SourceName.StartsWith(TEXT("HaybaMCP_ReplacementStaging"))
            || SourceName.StartsWith(TEXT("HaybaMCP_RetiredWidget")))
        {
            ++ScratchSourceCount;
        }
        const FGuid* Guid = WBP->WidgetVariableNameToGuidMap.Find(SourceWidget->GetFName());
        if (!Guid || !Guid->IsValid()) ++MissingSourceGuidCount;
    });
    TestEqual(TEXT("replacement leaves no staging/retired object in the compiler source population"),
        ScratchSourceCount, 0);
    TestEqual(TEXT("property preflight repairs every newly attached source GUID before compile"),
        MissingSourceGuidCount, 0);
    TestTrue(TEXT("TrackingText receives a compiler GUID"),
        WBP->WidgetVariableNameToGuidMap.FindRef(TEXT("TrackingText")).IsValid());

    FKismetEditorUtilities::CompileBlueprint(WBP);
    TestEqual(TEXT("widget blueprint compiles after safe and destructive replacements"), WBP->Status, BS_UpToDate);

    TestTrue(TEXT("temporary widget blueprint is deleted"), UEditorAssetLibrary::DeleteAsset(AssetPath));
#endif
    return true;
}
