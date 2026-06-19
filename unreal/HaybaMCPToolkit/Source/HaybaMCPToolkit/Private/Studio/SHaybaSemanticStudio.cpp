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
#include "Studio/SHaybaStudioViewport.h"
#include "Engine/StaticMesh.h"
#include "UObject/SoftObjectPath.h"

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

TSharedRef<SWidget> SHaybaSemanticStudio::BuildStudio()
{
    return SNew(SVerticalBox)

        // ── Toolbar row ──────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [
                SNew(SButton).ToolTipText(LOCTEXT("StudyAITip", "Have the AI study this mesh and propose masks + constraints"))
                [
                    SNew(SHorizontalBox)
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 4, 0)
                    [ SNew(SImage).Image(FAppStyle::Get().GetBrush("Icons.Search")) ]
                    + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
                    [ SNew(STextBlock).Text(LOCTEXT("StudyAI", "Study with AI")) ]
                ]
            ]
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [ SNew(SButton).Text(LOCTEXT("BakeGeo", "Bake Geometry")) ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(8, 0)
            [ SNew(STextBlock).Text(FText::FromString(AssetPath)) ]
        ]

        // ── Middle: mask list | viewport | inspector ─────────────────────
        + SVerticalBox::Slot().FillHeight(0.7f)
        [
            SNew(SSplitter).Orientation(Orient_Horizontal)
            + SSplitter::Slot().Value(0.22f)[ BuildMaskList() ]
            + SSplitter::Slot().Value(0.53f)[ BuildViewport() ]
            + SSplitter::Slot().Value(0.25f)[ SAssignNew(InspectorBox, SBox)[ BuildInspector() ] ]
        ]

        // ── Bottom: constraint node graph ────────────────────────────────
        + SVerticalBox::Slot().FillHeight(0.3f)
        [ SNew(SBorder).Padding(6)[ SNew(STextBlock).Text(LOCTEXT("Graph", "CONSTRAINT GRAPH")) ] ];
}

TSharedRef<SWidget> SHaybaSemanticStudio::BuildMaskList()
{
    return SNew(SBorder).Padding(4)
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(2)
        [ SNew(STextBlock).Text(FText::Format(LOCTEXT("MasksHeader", "MASKS ({0})"), FText::AsNumber(MaskItems.Num()))) ]
        + SVerticalBox::Slot().FillHeight(1.f)
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
