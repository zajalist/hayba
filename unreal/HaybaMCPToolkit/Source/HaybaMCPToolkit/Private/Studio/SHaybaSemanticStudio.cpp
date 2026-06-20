#include "Studio/SHaybaSemanticStudio.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Colors/SColorBlock.h"
#include "Widgets/Views/STableRow.h"
#include "Styling/AppStyle.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Studio/SHaybaStudioViewport.h"
#include "Studio/Graph/HaybaConstraintGraphNode.h"
#include "Studio/Graph/HaybaConstraintGraphSchema.h"
#include "Engine/StaticMesh.h"
#include "UObject/SoftObjectPath.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphPin.h"
#include "GraphEditor.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#define LOCTEXT_NAMESPACE "HaybaSemanticStudio"

void SHaybaSemanticStudio::Construct(const FArguments& InArgs)
{
    AssetPath = InArgs._AssetPath;
    ReloadProfile();
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];
}

void SHaybaSemanticStudio::SetAsset(const FString& InAssetPath)
{
    AssetPath = InAssetPath;
    ReloadProfile();
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];
}

void SHaybaSemanticStudio::ReloadProfile()
{
    SelectedMask.Reset();
    MaskItems.Reset();
    Profile = FHaybaStudioProfile();
    if (AssetPath.IsEmpty()) return;
    HaybaStudio::LoadProfile(AssetPath, Profile);
    for (const FHaybaStudioMask& M : Profile.Masks)
    {
        MaskItems.Add(MakeShared<FHaybaStudioMask>(M));
    }
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildEmptyState()
{
    return SNew(SBox).HAlign(HAlign_Center).VAlign(VAlign_Center)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
        [ SNew(SImage).Image(FAppStyle::Get().GetBrush("ClassIcon.StaticMesh")).DesiredSizeOverride(FVector2D(48, 48)) ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
        [ SNew(STextBlock).Font(FAppStyle::Get().GetFontStyle("HeadingExtraSmall")).Text(LOCTEXT("EmptyTitle", "No mesh open in the Semantic Studio")) ]
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
        [ SNew(STextBlock).AutoWrapText(true).Justification(ETextJustify::Center)
            .Text(LOCTEXT("EmptyBody", "Right-click a Static Mesh in the Content Browser and choose\n\"Open with Hayba\" to author its masks and constraints here.")) ]
    ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildToolbar()
{
    FSlimHorizontalToolBarBuilder Builder(TSharedPtr<FUICommandList>(), FMultiBoxCustomization::None);
    Builder.BeginSection("Studio");
    Builder.AddToolBarButton(
        FUIAction(),
        NAME_None,
        LOCTEXT("StudyAI", "Study with AI"),
        LOCTEXT("StudyAITip", "Have the AI study this mesh and propose masks + constraints"),
        FSlateIcon(FAppStyle::GetAppStyleSetName(), "Icons.Search"));
    Builder.AddToolBarButton(
        FUIAction(),
        NAME_None,
        LOCTEXT("BakeGeo", "Bake Geometry"),
        LOCTEXT("BakeGeoTip", "Re-bake the deterministic geometry profile from the mesh bounds"),
        FSlateIcon(FAppStyle::GetAppStyleSetName(), "Icons.Convert"));
    Builder.AddSeparator();
    Builder.AddToolBarButton(
        FUIAction(FExecuteAction::CreateLambda([this]() { OnSaveConstraints(); })),
        NAME_None,
        LOCTEXT("SaveConstraints", "Save Constraints"),
        LOCTEXT("SaveTip", "Compile the node graph to PLUMB constraints (.scratch/constraints.json)"),
        FSlateIcon(FAppStyle::GetAppStyleSetName(), "Icons.Save"));
    Builder.EndSection();

    return SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Panel"))
        .Padding(FMargin(4, 2))
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[ Builder.MakeWidget() ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(12, 0)
            [ SNew(STextBlock).ColorAndOpacity(FSlateColor::UseSubduedForeground()).Text(FText::FromString(AssetPath)) ]
        ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildStudio()
{
    return SNew(SVerticalBox)

        // ── Toolbar ──────────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight()
        [ BuildToolbar() ]

        // ── Resizable body: (masks | viewport | inspector) over the graph ─
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SNew(SSplitter).Orientation(Orient_Vertical)
            + SSplitter::Slot().Value(0.68f)
            [
                SNew(SSplitter).Orientation(Orient_Horizontal)
                + SSplitter::Slot().Value(0.22f)[ BuildMaskList() ]
                + SSplitter::Slot().Value(0.53f)[ BuildViewport() ]
                + SSplitter::Slot().Value(0.25f)[ SAssignNew(InspectorBox, SBox)[ BuildInspector() ] ]
            ]
            + SSplitter::Slot().Value(0.32f)
            [ BuildGraph() ]
        ];
}

// Styled section header used by each panel — group-border feel like the
// Material Editor's docked tabs.
static TSharedRef<SWidget> StudioPanelHeader(const FText& Label)
{
    return SNew(SBorder)
        .BorderImage(FAppStyle::Get().GetBrush("Brushes.Header"))
        .Padding(FMargin(6, 3))
        [ SNew(STextBlock).TextStyle(FAppStyle::Get(), "ButtonText").Text(Label) ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildGraph()
{
    // Fresh transient graph per asset, schema = the closed constraint schema.
    ConstraintGraph = NewObject<UEdGraph>(GetTransientPackage(), UEdGraph::StaticClass(), NAME_None, RF_Transient);
    ConstraintGraph->Schema = UHaybaConstraintGraphSchema::StaticClass();
    ConstraintGraph->GetSchema()->CreateDefaultNodesForGraph(*ConstraintGraph);

    SGraphEditor::FGraphEditorEvents Events;
    Events.OnSelectionChanged = SGraphEditor::FOnSelectionChanged::CreateSP(this, &SHaybaSemanticStudio::OnGraphSelectionChanged);

    return SNew(SSplitter).Orientation(Orient_Horizontal)
        + SSplitter::Slot().Value(0.78f)
        [
            SAssignNew(GraphEditorWidget, SGraphEditor)
            .GraphToEdit(ConstraintGraph)
            .GraphEvents(Events)
        ]
        + SSplitter::Slot().Value(0.22f)
        [
            SNew(SBorder).Padding(6)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight().Padding(2)
                [ SNew(STextBlock).Text(LOCTEXT("NodeInsp", "NODE INSPECTOR")) ]
                + SVerticalBox::Slot().FillHeight(1.f)
                [ SAssignNew(NodeInspectorBox, SBox)[ BuildNodeInspector() ] ]
            ]
        ];
}

void SHaybaSemanticStudio::OnGraphSelectionChanged(const TSet<UObject*>& NewSelection)
{
    SelectedGraphNode.Reset();
    for (UObject* Obj : NewSelection)
    {
        if (UHaybaConstraintGraphNode* N = Cast<UHaybaConstraintGraphNode>(Obj)) { SelectedGraphNode = N; break; }
    }
    if (NodeInspectorBox.IsValid()) NodeInspectorBox->SetContent(BuildNodeInspector());
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildNodeInspector()
{
    UHaybaConstraintGraphNode* Node = SelectedGraphNode.Get();
    if (!Node)
    {
        return SNew(STextBlock).Text(LOCTEXT("NoNode", "Select a node")).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f)));
    }

    TSharedRef<SVerticalBox> Box = SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(2)
        [ SNew(STextBlock).Font(FAppStyle::Get().GetFontStyle("HeadingExtraSmall")).Text(Node->GetNodeTitle(ENodeTitleType::ListView)) ];

    if (Node->Kind == EHaybaNodeKind::Mask)
    {
        // Pick which profile mask this node references.
        for (const FHaybaStudioMask& M : Profile.Masks)
        {
            const FString MaskId = M.Id;
            const bool bCurrent = (Node->MaskId == MaskId);
            Box->AddSlot().AutoHeight().Padding(2)
            [
                SNew(SButton)
                .Text(FText::FromString(MaskId))
                .ButtonColorAndOpacity(bCurrent ? FLinearColor(0.2f, 0.5f, 0.9f) : FLinearColor(0.25f, 0.25f, 0.25f))
                .OnClicked_Lambda([this, MaskId]()
                {
                    if (UHaybaConstraintGraphNode* N = SelectedGraphNode.Get())
                    {
                        N->MaskId = MaskId;
                        N->ReconstructNode();
                        if (GraphEditorWidget.IsValid()) GraphEditorWidget->NotifyGraphChanged();
                        if (NodeInspectorBox.IsValid()) NodeInspectorBox->SetContent(BuildNodeInspector());
                    }
                    return FReply::Handled();
                })
            ];
        }
        if (Profile.Masks.Num() == 0)
        {
            Box->AddSlot().AutoHeight().Padding(2)[ SNew(STextBlock).Text(LOCTEXT("NoMasks", "No masks on this profile")) ];
        }
    }
    else
    {
        Box->AddSlot().AutoHeight().Padding(2)
        [ SNew(STextBlock).AutoWrapText(true).Text(LOCTEXT("NodeNoProps", "No editable properties for this node yet.")) ];
    }

    return Box;
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildMaskList()
{
    return SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder")).Padding(0)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ StudioPanelHeader(FText::Format(LOCTEXT("MasksHeader", "MASKS  ({0})"), FText::AsNumber(MaskItems.Num()))) ]
        + SVerticalBox::Slot().FillHeight(1.f).Padding(2)
        [
            SAssignNew(MaskListView, SListView<TSharedPtr<FHaybaStudioMask>>)
            .ListItemsSource(&MaskItems)
            .OnGenerateRow(this, &SHaybaSemanticStudio::GenerateMaskRow)
            .OnSelectionChanged(this, &SHaybaSemanticStudio::OnMaskSelected)
            .SelectionMode(ESelectionMode::Single)
        ]
    ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildViewport()
{
    TSharedRef<SHaybaStudioViewport> V = SNew(SHaybaStudioViewport);
    Viewport = V;
    UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *AssetPath);
    V->SetPreviewMesh(Mesh);
    PushMasksToViewport();
    return V;
}

void SHaybaSemanticStudio::AddReferencedObjects(FReferenceCollector& Collector)
{
    Collector.AddReferencedObject(ConstraintGraph);
}

FReply SHaybaSemanticStudio::OnSaveConstraints()
{
    if (!ConstraintGraph || AssetPath.IsEmpty()) return FReply::Handled();

    const FString Path = FPaths::Combine(HaybaStudio::ScratchDir(), TEXT("constraints.json"));

    // Merge: keep constraints bound to OTHER assets, replace this asset's.
    TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
    {
        FString Existing;
        if (FFileHelper::LoadFileToString(Existing, *Path))
        {
            TSharedPtr<FJsonObject> Old;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Existing);
            if (FJsonSerializer::Deserialize(Reader, Old) && Old.IsValid())
            {
                for (const auto& Pair : Old->Values)
                {
                    const TSharedPtr<FJsonObject> C = Pair.Value->AsObject();
                    FString BoundAsset;
                    if (C.IsValid())
                    {
                        const TSharedPtr<FJsonObject>* B = nullptr;
                        if (C->TryGetObjectField(TEXT("binding"), B) && B)
                            (*B)->TryGetStringField(TEXT("asset"), BoundAsset);
                    }
                    if (BoundAsset != AssetPath && C.IsValid()) Root->SetObjectField(Pair.Key, C);
                }
            }
        }
    }

    const FString Base = FPaths::GetBaseFilename(AssetPath);
    int32 Index = 0;
    for (UEdGraphNode* N : ConstraintGraph->Nodes)
    {
        UHaybaConstraintGraphNode* HN = Cast<UHaybaConstraintGraphNode>(N);
        if (!HN || HN->Kind != EHaybaNodeKind::Primitive) continue;

        // A mask wired into the primitive's input becomes params.mask.
        FString MaskId;
        for (UEdGraphPin* Pin : HN->Pins)
        {
            if (Pin->Direction != EGPD_Input) continue;
            for (UEdGraphPin* Linked : Pin->LinkedTo)
            {
                if (UHaybaConstraintGraphNode* Src = Cast<UHaybaConstraintGraphNode>(Linked->GetOwningNode()))
                    if (Src->Kind == EHaybaNodeKind::Mask) MaskId = Src->MaskId;
            }
        }

        const FString Id = FString::Printf(TEXT("%s_%s_%d"), *Base, *HN->PrimitiveId, Index++);
        TSharedPtr<FJsonObject> C = MakeShared<FJsonObject>();
        C->SetStringField(TEXT("id"), Id);
        C->SetStringField(TEXT("primitive"), HN->PrimitiveId);
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        if (!MaskId.IsEmpty()) Params->SetStringField(TEXT("mask"), MaskId);
        C->SetObjectField(TEXT("params"), Params);
        TSharedPtr<FJsonObject> Binding = MakeShared<FJsonObject>();
        Binding->SetStringField(TEXT("asset"), AssetPath);
        C->SetObjectField(TEXT("binding"), Binding);
        C->SetBoolField(TEXT("enabled"), true);
        Root->SetObjectField(Id, C);
    }

    FString Out;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(Root.ToSharedRef(), Writer);
    FFileHelper::SaveStringToFile(Out, *Path);

    UE_LOG(LogTemp, Log, TEXT("[Hayba Studio] compiled %d primitive node(s) -> %s"), Index, *Path);
    return FReply::Handled();
}

void SHaybaSemanticStudio::PushMasksToViewport()
{
    if (!Viewport.IsValid()) return;
    const FString SelId = SelectedMask.IsValid() ? SelectedMask->Id : FString();
    Viewport->SetMasks(Profile.Masks, HiddenMaskIds, SelId);
}

TSharedRef<ITableRow> SHaybaSemanticStudio::GenerateMaskRow(TSharedPtr<FHaybaStudioMask> Mask, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FHaybaStudioMask>>, Owner)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
        [ SNew(SColorBlock).Color(Mask->Color).Size(FVector2D(14, 14)) ]
        + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(4, 0)
        [ SNew(STextBlock).Text(FText::FromString(Mask->Id)) ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
        [ SNew(STextBlock).Text(FText::FromString(Mask->Type)).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))) ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
        [ SNew(SImage).Image(FAppStyle::Get().GetBrush("Icons.Lock"))
                      .Visibility(Mask->bLocked ? EVisibility::Visible : EVisibility::Collapsed) ]
        + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(2)
        [
            SNew(SCheckBox)
            .ToolTipText(LOCTEXT("MaskVisible", "Show this mask in the viewport"))
            .IsChecked_Lambda([this, Mask]() { return HiddenMaskIds.Contains(Mask->Id) ? ECheckBoxState::Unchecked : ECheckBoxState::Checked; })
            .OnCheckStateChanged_Lambda([this, Mask](ECheckBoxState S)
            {
                if (S == ECheckBoxState::Checked) HiddenMaskIds.Remove(Mask->Id);
                else HiddenMaskIds.Add(Mask->Id);
                PushMasksToViewport();
            })
        ]
    ];
}

void SHaybaSemanticStudio::OnMaskSelected(TSharedPtr<FHaybaStudioMask> Mask, ESelectInfo::Type)
{
    SelectedMask = Mask;
    if (InspectorBox.IsValid()) InspectorBox->SetContent(BuildInspector());
    PushMasksToViewport();
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildInspector()
{
    if (!SelectedMask.IsValid())
    {
        return SNew(SBorder).Padding(8)
        [ SNew(STextBlock).Text(LOCTEXT("NoSelection", "Select a mask")).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))) ];
    }

    const FHaybaStudioMask& M = *SelectedMask;
    auto Field = [](const FText& Label, const FString& Value)
    {
        return SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.4f)[ SNew(STextBlock).Text(Label).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))) ]
            + SHorizontalBox::Slot().FillWidth(0.6f)[ SNew(STextBlock).Text(FText::FromString(Value)).AutoWrapText(true) ];
    };

    return SNew(SBorder).Padding(8)
    [
        SNew(SScrollBox)
        + SScrollBox::Slot().Padding(2)[ SNew(STextBlock).Font(FAppStyle::Get().GetFontStyle("HeadingExtraSmall")).Text(FText::FromString(M.Id)) ]
        + SScrollBox::Slot().Padding(2)[ Field(LOCTEXT("FType", "type"), M.Type) ]
        + SScrollBox::Slot().Padding(2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.4f)[ SNew(STextBlock).Text(LOCTEXT("FColor", "color")).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))) ]
            + SHorizontalBox::Slot().AutoWidth()[ SNew(SColorBlock).Color(M.Color).Size(FVector2D(28, 14)) ]
        ]
        + SScrollBox::Slot().Padding(2)[ Field(LOCTEXT("FSource", "source"), M.Source) ]
        + SScrollBox::Slot().Padding(2)[ Field(LOCTEXT("FConf", "confidence"), FString::SanitizeFloat(M.Confidence)) ]
        + SScrollBox::Slot().Padding(2)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().FillWidth(0.4f)[ SNew(STextBlock).Text(LOCTEXT("FLock", "locked")).ColorAndOpacity(FSlateColor(FLinearColor(0.6f, 0.6f, 0.6f))) ]
            + SHorizontalBox::Slot().AutoWidth()[ SNew(SCheckBox).IsChecked(M.bLocked ? ECheckBoxState::Checked : ECheckBoxState::Unchecked).IsEnabled(false) ]
        ]
        + SScrollBox::Slot().Padding(2)[ Field(LOCTEXT("FDetail", "detail"), M.Detail) ]
    ];
}

#undef LOCTEXT_NAMESPACE
