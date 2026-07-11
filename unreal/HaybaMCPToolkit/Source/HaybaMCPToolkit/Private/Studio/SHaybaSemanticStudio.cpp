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
#include "EdGraphUtilities.h"
#include "GraphEditor.h"
#include "Framework/Commands/GenericCommands.h"
#include "Framework/Commands/UICommandList.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/FileManager.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"

#define LOCTEXT_NAMESPACE "HaybaSemanticStudio"

namespace { FString StudyRequestsFile() { return FPaths::Combine(HaybaStudio::ScratchDir(), TEXT("study-requests.jsonl")); }
            FString ProfilesStoreFile() { return FPaths::Combine(HaybaStudio::ScratchDir(), TEXT("profiles.json")); } }

void SHaybaSemanticStudio::Construct(const FArguments& InArgs)
{
    AssetPath = InArgs._AssetPath;
    ReloadProfile();
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];

    // Auto-refresh: poll the profiles store mtime so masks the agent authors
    // (after a "Study with AI" request) appear without a manual reload.
    LastProfileStamp = IFileManager::Get().GetTimeStamp(*ProfilesStoreFile());
    PollTicker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateSP(this, &SHaybaSemanticStudio::PollStores), 1.0f);
}

SHaybaSemanticStudio::~SHaybaSemanticStudio()
{
    if (PollTicker.IsValid()) { FTSTicker::GetCoreTicker().RemoveTicker(PollTicker); PollTicker.Reset(); }
}

void SHaybaSemanticStudio::SetAsset(const FString& InAssetPath)
{
    AssetPath = InAssetPath;
    ReloadProfile();
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];
    LastProfileStamp = IFileManager::Get().GetTimeStamp(*ProfilesStoreFile());
}

FReply SHaybaSemanticStudio::OnStudyWithAI()
{
    if (AssetPath.IsEmpty()) return FReply::Handled();
    const FString Line = FString::Printf(TEXT("{\"asset\":\"%s\",\"ts\":\"%s\"}\n"), *AssetPath, *FDateTime::UtcNow().ToIso8601());
    FFileHelper::SaveStringToFile(Line, *StudyRequestsFile(), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM,
        &IFileManager::Get(), FILEWRITE_Append);

    FNotificationInfo Info(LOCTEXT("StudyQueued", "Queued for AI study — masks + constraints will appear here when ready."));
    Info.ExpireDuration = 4.0f;
    FSlateNotificationManager::Get().AddNotification(Info);
    return FReply::Handled();
}

void SHaybaSemanticStudio::RefreshFromStores()
{
    ReloadProfile();
    if (MaskListView.IsValid()) MaskListView->RequestListRefresh();
    PushMasksToViewport();
    if (InspectorBox.IsValid()) InspectorBox->SetContent(BuildInspector());
}

bool SHaybaSemanticStudio::PollStores(float)
{
    if (AssetPath.IsEmpty()) return true;
    const FDateTime Stamp = IFileManager::Get().GetTimeStamp(*ProfilesStoreFile());
    if (Stamp != FDateTime() && Stamp != LastProfileStamp)
    {
        LastProfileStamp = Stamp;
        RefreshFromStores();
    }
    return true;
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
        FUIAction(FExecuteAction::CreateLambda([this]() { OnStudyWithAI(); })),
        NAME_None,
        LOCTEXT("StudyAI", "Study with AI"),
        LOCTEXT("StudyAITip", "Queue this mesh for the AI to study — it proposes masks + constraints; the Studio refreshes automatically"),
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

    BindGraphCommands();

    SGraphEditor::FGraphEditorEvents Events;
    Events.OnSelectionChanged = SGraphEditor::FOnSelectionChanged::CreateSP(this, &SHaybaSemanticStudio::OnGraphSelectionChanged);

    // [ palette | (navbar / graph) | node inspector ]
    return SNew(SSplitter).Orientation(Orient_Horizontal)
        + SSplitter::Slot().Value(0.18f)
        [ BuildGraphPalette() ]
        + SSplitter::Slot().Value(0.62f)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight()
            [
                SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("Brushes.Header")).Padding(FMargin(8, 3))
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                    [ SNew(SImage).Image(FAppStyle::Get().GetBrush("GraphEditor.EventGraph_16x")) ]
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6, 0, 0, 0)
                    [ SNew(STextBlock).TextStyle(FAppStyle::Get(), "ButtonText").Text(LOCTEXT("GraphTitle", "Constraint Graph")) ]
                    + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).HAlign(HAlign_Right)
                    [ SNew(STextBlock).ColorAndOpacity(FSlateColor::UseSubduedForeground()).Text(LOCTEXT("GraphHint", "right-click or use the palette to add nodes")) ]
                ]
            ]
            + SVerticalBox::Slot().FillHeight(1.f)
            [
                SAssignNew(GraphEditorWidget, SGraphEditor)
                .GraphToEdit(ConstraintGraph)
                .GraphEvents(Events)
                .AdditionalCommands(GraphCommands)
            ]
        ]
        + SSplitter::Slot().Value(0.20f)
        [
            SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder")).Padding(0)
            [
                SNew(SVerticalBox)
                + SVerticalBox::Slot().AutoHeight()
                [ StudioPanelHeader(LOCTEXT("NodeInsp", "NODE INSPECTOR")) ]
                + SVerticalBox::Slot().FillHeight(1.f).Padding(4)
                [ SAssignNew(NodeInspectorBox, SBox)[ BuildNodeInspector() ] ]
            ]
        ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildGraphPalette()
{
    TArray<FHaybaPaletteEntry> Palette;
    HaybaGetClosedPalette(Palette);

    TSharedRef<SVerticalBox> List = SNew(SVerticalBox);
    FString CurrentCategory;
    for (const FHaybaPaletteEntry& E : Palette)
    {
        if (E.Category != CurrentCategory)
        {
            CurrentCategory = E.Category;
            List->AddSlot().AutoHeight().Padding(4, 6, 4, 2)
            [ SNew(STextBlock).ColorAndOpacity(FSlateColor::UseSubduedForeground()).Text(FText::FromString(CurrentCategory.ToUpper())) ];
        }
        const uint8 Kind = (uint8)E.Kind;
        const FString Id = E.Id;
        List->AddSlot().AutoHeight().Padding(2, 1)
        [
            SNew(SButton)
            .HAlign(HAlign_Left)
            .ToolTipText(LOCTEXT("PaletteAddTip", "Add this node to the graph"))
            .OnClicked_Lambda([this, Kind, Id]() { AddGraphNode(Kind, Id); return FReply::Handled(); })
            [ SNew(STextBlock).Text(FText::FromString(E.Label)) ]
        ];
    }

    return SNew(SBorder).BorderImage(FAppStyle::Get().GetBrush("ToolPanel.GroupBorder")).Padding(0)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight()
        [ StudioPanelHeader(LOCTEXT("Palette", "PALETTE")) ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [ SNew(SScrollBox) + SScrollBox::Slot()[ List ] ]
    ];
}

void SHaybaSemanticStudio::BindGraphCommands()
{
    if (GraphCommands.IsValid()) return;
    GraphCommands = MakeShared<FUICommandList>();
    const FGenericCommands& G = FGenericCommands::Get();

    GraphCommands->MapAction(G.Delete,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::DeleteSelectedGraphNodes),
        FCanExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CanDeleteGraphNodes));
    GraphCommands->MapAction(G.Copy,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CopySelectedGraphNodes),
        FCanExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CanCopyGraphNodes));
    GraphCommands->MapAction(G.Cut,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CutSelectedGraphNodes),
        FCanExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CanCopyGraphNodes));
    GraphCommands->MapAction(G.Paste,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::PasteGraphNodes),
        FCanExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CanPasteGraphNodes));
    GraphCommands->MapAction(G.Duplicate,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::DuplicateGraphNodes),
        FCanExecuteAction::CreateSP(this, &SHaybaSemanticStudio::CanCopyGraphNodes));
    GraphCommands->MapAction(G.SelectAll,
        FExecuteAction::CreateSP(this, &SHaybaSemanticStudio::SelectAllGraphNodes));
}

void SHaybaSemanticStudio::DeleteSelectedGraphNodes()
{
    if (!GraphEditorWidget.IsValid()) return;
    const FGraphPanelSelectionSet Selected = GraphEditorWidget->GetSelectedNodes();
    GraphEditorWidget->ClearSelectionSet();
    for (UObject* Obj : Selected)
    {
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(Obj))
        {
            if (Node->CanUserDeleteNode()) { Node->Modify(); Node->DestroyNode(); }
        }
    }
    GraphEditorWidget->NotifyGraphChanged();
}

bool SHaybaSemanticStudio::CanDeleteGraphNodes() const
{
    if (!GraphEditorWidget.IsValid()) return false;
    for (UObject* Obj : GraphEditorWidget->GetSelectedNodes())
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(Obj)) if (Node->CanUserDeleteNode()) return true;
    return false;
}

void SHaybaSemanticStudio::CopySelectedGraphNodes()
{
    if (!GraphEditorWidget.IsValid()) return;
    const FGraphPanelSelectionSet Selected = GraphEditorWidget->GetSelectedNodes();
    for (UObject* Obj : Selected) if (UEdGraphNode* Node = Cast<UEdGraphNode>(Obj)) Node->PrepareForCopying();
    FString Exported;
    FEdGraphUtilities::ExportNodesToText(Selected, Exported);
    FPlatformApplicationMisc::ClipboardCopy(*Exported);
}

bool SHaybaSemanticStudio::CanCopyGraphNodes() const
{
    return GraphEditorWidget.IsValid() && GraphEditorWidget->GetSelectedNodes().Num() > 0;
}

void SHaybaSemanticStudio::CutSelectedGraphNodes()
{
    CopySelectedGraphNodes();
    DeleteSelectedGraphNodes();
}

void SHaybaSemanticStudio::PasteGraphNodes()
{
    if (!GraphEditorWidget.IsValid() || !ConstraintGraph) return;
    FString TextToImport;
    FPlatformApplicationMisc::ClipboardPaste(TextToImport);
    if (!FEdGraphUtilities::CanImportNodesFromText(ConstraintGraph, TextToImport)) return;

    TSet<UEdGraphNode*> Imported;
    FEdGraphUtilities::ImportNodesFromText(ConstraintGraph, TextToImport, Imported);

    GraphEditorWidget->ClearSelectionSet();
    for (UEdGraphNode* Node : Imported)
    {
        Node->NodePosX += 40;
        Node->NodePosY += 40;
        Node->CreateNewGuid();
        GraphEditorWidget->SetNodeSelection(Node, true);
    }
    GraphEditorWidget->NotifyGraphChanged();
}

bool SHaybaSemanticStudio::CanPasteGraphNodes() const
{
    if (!ConstraintGraph) return false;
    FString Text;
    FPlatformApplicationMisc::ClipboardPaste(Text);
    return FEdGraphUtilities::CanImportNodesFromText(ConstraintGraph, Text);
}

void SHaybaSemanticStudio::DuplicateGraphNodes()
{
    CopySelectedGraphNodes();
    PasteGraphNodes();
}

void SHaybaSemanticStudio::SelectAllGraphNodes()
{
    if (!GraphEditorWidget.IsValid() || !ConstraintGraph) return;
    GraphEditorWidget->ClearSelectionSet();
    for (UEdGraphNode* Node : ConstraintGraph->Nodes)
        if (Node) GraphEditorWidget->SetNodeSelection(Node, true);
}

void SHaybaSemanticStudio::AddGraphNode(uint8 Kind, const FString& Id)
{
    if (!ConstraintGraph) return;
    UHaybaConstraintGraphNode* Node = NewObject<UHaybaConstraintGraphNode>(ConstraintGraph);
    Node->Kind = (EHaybaNodeKind)Kind;
    if (Node->Kind == EHaybaNodeKind::Primitive) Node->PrimitiveId = Id;
    else if (Node->Kind == EHaybaNodeKind::Gate) Node->GateName = Id;
    Node->CreateNewGuid();
    Node->NodePosX = 40 + (PaletteSpawnCount % 4) * 40;
    Node->NodePosY = 40 + (PaletteSpawnCount % 8) * 30;
    ++PaletteSpawnCount;
    ConstraintGraph->AddNode(Node, true, false);
    Node->AllocateDefaultPins();
    if (GraphEditorWidget.IsValid()) GraphEditorWidget->NotifyGraphChanged();
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
                    if (BoundAsset != AssetPath && C.IsValid()) Root->SetObjectField(FString(*Pair.Key), C);
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
