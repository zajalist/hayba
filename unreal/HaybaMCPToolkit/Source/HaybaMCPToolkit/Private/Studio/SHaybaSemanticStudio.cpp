#include "Studio/SHaybaSemanticStudio.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"

#define LOCTEXT_NAMESPACE "HaybaSemanticStudio"

void SHaybaSemanticStudio::Construct(const FArguments& InArgs)
{
    AssetPath = InArgs._AssetPath;

    ChildSlot
    [
        SNew(SVerticalBox)

        // ── Toolbar row ──────────────────────────────────────────────────
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [ SNew(SButton).Text(LOCTEXT("StudyAI", "Study with AI ▸")) ]
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [ SNew(SButton).Text(LOCTEXT("BakeGeo", "Bake Geometry")) ]
            + SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(8, 0)
            [ SNew(STextBlock).Text(FText::FromString(AssetPath.IsEmpty() ? TEXT("(no asset)") : AssetPath)) ]
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
        ]
    ];
}

#undef LOCTEXT_NAMESPACE
