#include "Studio/SHaybaSemanticStudio.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Styling/AppStyle.h"

#define LOCTEXT_NAMESPACE "HaybaSemanticStudio"

void SHaybaSemanticStudio::Construct(const FArguments& InArgs)
{
    AssetPath = InArgs._AssetPath;
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];
}

void SHaybaSemanticStudio::SetAsset(const FString& InAssetPath)
{
    AssetPath = InAssetPath;
    ChildSlot [ AssetPath.IsEmpty() ? BuildEmptyState() : BuildStudio() ];
}

// Shown until the user targets a mesh — explicit instruction on HOW to enter.
TSharedRef<SWidget> SHaybaSemanticStudio::BuildEmptyState()
{
    return SNew(SBox)
        .HAlign(HAlign_Center)
        .VAlign(VAlign_Center)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
            [
                SNew(SImage).Image(FAppStyle::Get().GetBrush("ClassIcon.StaticMesh"))
                            .DesiredSizeOverride(FVector2D(48, 48))
            ]
            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
            [
                SNew(STextBlock)
                .Font(FAppStyle::Get().GetFontStyle("HeadingExtraSmall"))
                .Text(LOCTEXT("EmptyTitle", "No mesh open in the Semantic Studio"))
            ]
            + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(8)
            [
                SNew(STextBlock)
                .AutoWrapText(true)
                .Justification(ETextJustify::Center)
                .Text(LOCTEXT("EmptyBody",
                    "Right-click a Static Mesh in the Content Browser and choose\n\"Open with Hayba\" to author its masks and constraints here."))
            ]
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
            + SSplitter::Slot().Value(0.2f)
            [ SNew(SBorder).Padding(6)[ SNew(STextBlock).Text(LOCTEXT("Masks", "MASKS")) ] ]
            + SSplitter::Slot().Value(0.55f)
            [ SNew(SBorder).Padding(6)[ SNew(STextBlock).Text(LOCTEXT("Viewport", "VIEWPORT")) ] ]
            + SSplitter::Slot().Value(0.25f)
            [ SNew(SBorder).Padding(6)[ SNew(STextBlock).Text(LOCTEXT("Inspector", "INSPECTOR")) ] ]
        ]

        // ── Bottom: constraint node graph ────────────────────────────────
        + SVerticalBox::Slot().FillHeight(0.3f)
        [
            SNew(SBorder).Padding(6)[ SNew(STextBlock).Text(LOCTEXT("Graph", "CONSTRAINT GRAPH")) ]
        ];
}

#undef LOCTEXT_NAMESPACE
