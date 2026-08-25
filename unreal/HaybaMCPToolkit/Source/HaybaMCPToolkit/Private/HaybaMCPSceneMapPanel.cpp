// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapPanel.cpp
#include "HaybaMCPSceneMapPanel.h"
#include "HaybaMCPStyle.h"
#include "HaybaMCPCogMapBuilder.h"

#include "Widgets/SCanvas.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Styling/AppStyle.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/Selection.h"
#include "GameFramework/Actor.h"

// ── Construct ──────────────────────────────────────────────────────────────

void SHaybaMCPSceneMapPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SAssignNew(Viewport, SBox)
        [
            SAssignNew(CanvasInner, SCanvas)
        ]
    ];

    Refresh();
}

// ── Tick — keep viewport size cached for FitView and re-apply transform ─

void SHaybaMCPSceneMapPanel::Tick(const FGeometry& AllottedGeometry, const double InCurrentTime, const float InDeltaTime)
{
    SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
    LastViewportSize = AllottedGeometry.GetLocalSize();
}

// ── Data path ──────────────────────────────────────────────────────────────

void SHaybaMCPSceneMapPanel::Refresh()
{
    if (!GEditor) { Cells.Reset(); RebuildCanvas(); return; }
    UWorld* World = GEditor->GetEditorWorldContext().World();
    Cells = HaybaCogMap::BuildForWorld(World);
    RebuildCanvas();
    FitView();
}

// ── Rebuild SCanvas children from the cell list ────────────────────────────

void SHaybaMCPSceneMapPanel::RebuildCanvas()
{
    if (!CanvasInner.IsValid()) return;
    CanvasInner->ClearChildren();

    for (int32 i = 0; i < Cells.Num(); ++i)
    {
        const FHaybaCogMapCell& Cell = Cells[i];
        const FVector2D Pos  = Cell.Bounds.Min;
        const FVector2D Size = Cell.Bounds.GetSize();

        CanvasInner->AddSlot()
            .Position(Pos)
            .Size(Size)
            [ BuildCellWidget(i) ];
    }
}

void SHaybaMCPSceneMapPanel::ApplyTransform()
{
    // RenderTransform on the SCanvas: scale by Zoom, translate by PanOffset.
    if (!CanvasInner.IsValid()) return;
    FSlateRenderTransform XForm(Zoom, PanOffset);
    CanvasInner->SetRenderTransform(XForm);
}

// ── Cell widget ────────────────────────────────────────────────────────────

TSharedRef<SWidget> SHaybaMCPSceneMapPanel::BuildCellWidget(int32 CellIndex)
{
    if (!Cells.IsValidIndex(CellIndex)) return SNullWidget::NullWidget;
    const FHaybaCogMapCell& Cell = Cells[CellIndex];
    const FLinearColor BaseColor = ColorForSemantic(Cell.Semantic);
    FLinearColor Fill = BaseColor;
    Fill.A = 0.20f;
    FLinearColor Stroke = BaseColor;
    Stroke.A = 0.85f;

    // Tooltip: top 5 dominant classes.
    FString Tip = FString::Printf(TEXT("%s · %d actor%s\n\nTop classes:\n"),
        *Cell.Label, Cell.ActorCount, Cell.ActorCount == 1 ? TEXT("") : TEXT("s"));
    for (const FString& C : Cell.DominantClasses) Tip += TEXT("  • ") + C + TEXT("\n");

    return SNew(SButton)
        .ButtonStyle(FAppStyle::Get(), "SimpleButton")
        .ContentPadding(FMargin(0.f))
        .ToolTipText(FText::FromString(Tip))
        .OnClicked_Lambda([this, CellIndex]()
        {
            OnCellClicked(CellIndex);
            return FReply::Handled();
        })
        [
            SNew(SBorder)
            .BorderImage(FAppStyle::Get().GetBrush("WhiteBrush"))
            .BorderBackgroundColor(FSlateColor(Stroke))
            .Padding(FMargin(2.f))
            [
                SNew(SBorder)
                .BorderImage(FAppStyle::Get().GetBrush("WhiteBrush"))
                .BorderBackgroundColor(FSlateColor(Fill))
                .Padding(FMargin(6.f, 4.f))
                .HAlign(HAlign_Left)
                .VAlign(VAlign_Top)
                [
                    SNew(SVerticalBox)
                    + SVerticalBox::Slot().AutoHeight()
                    [
                        SNew(STextBlock)
                        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("NormalText"))
                        .Text(FText::FromString(Cell.Label))
                        .ColorAndOpacity(FSlateColor(FLinearColor::White))
                    ]
                    + SVerticalBox::Slot().AutoHeight()
                    [
                        SNew(STextBlock)
                        .TextStyle(&FAppStyle::Get().GetWidgetStyle<FTextBlockStyle>("SmallText"))
                        .Text(FText::FromString(FString::Printf(TEXT("%d"), Cell.ActorCount)))
                        .ColorAndOpacity(FSlateColor(FHaybaMCPStyle::Colour("Hayba.Color.Text.Primary")))
                    ]
                ]
            ]
        ];
}

void SHaybaMCPSceneMapPanel::OnCellClicked(int32 CellIndex)
{
    if (!GEditor || !Cells.IsValidIndex(CellIndex)) return;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return;

    GEditor->SelectNone(false, true);
    TSet<FString> Labels(Cells[CellIndex].ActorLabels);
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (AActor* A = *It; Labels.Contains(A->GetActorLabel()))
        {
            GEditor->SelectActor(A, true, /*bNotify=*/false, /*bSelectEvenIfHidden=*/true);
        }
    }
    GEditor->NoteSelectionChange();
}

// ── Fit / Reset ────────────────────────────────────────────────────────────

void SHaybaMCPSceneMapPanel::FitView()
{
    if (Cells.IsEmpty()) { ResetView(); return; }
    FBox2D World(ForceInit);
    for (const auto& C : Cells) World += C.Bounds;
    const FVector2D WorldSize = World.GetSize();
    const FVector2D View = LastViewportSize - FVector2D(20.f, 20.f); // 10px margin each side
    if (WorldSize.X <= 0.f || WorldSize.Y <= 0.f) { ResetView(); return; }

    const float ZX = View.X / FMath::Max((float)WorldSize.X, 1.f);
    const float ZY = View.Y / FMath::Max((float)WorldSize.Y, 1.f);
    Zoom = FMath::Clamp(FMath::Min(ZX, ZY), 0.05f, 10.f);

    // Place the world's top-left at (10,10) in local widget space after scaling.
    PanOffset = FVector2D(10.f, 10.f) - World.Min * Zoom;
    ApplyTransform();
}

void SHaybaMCPSceneMapPanel::ResetView()
{
    PanOffset = FVector2D::ZeroVector;
    Zoom = 1.f;
    ApplyTransform();
}

// ── Pan / zoom input ───────────────────────────────────────────────────────

FReply SHaybaMCPSceneMapPanel::OnMouseMove(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (MouseEvent.IsMouseButtonDown(EKeys::RightMouseButton))
    {
        PanOffset += MouseEvent.GetCursorDelta();
        ApplyTransform();
        return FReply::Handled();
    }
    return FReply::Unhandled();
}

FReply SHaybaMCPSceneMapPanel::OnMouseWheel(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    const float Old = Zoom;
    Zoom = FMath::Clamp(Zoom * (1.f + MouseEvent.GetWheelDelta() * 0.1f), 0.05f, 10.f);
    // Zoom around the cursor: keep the world point under the cursor stable.
    const FVector2D Local = MyGeometry.AbsoluteToLocal(MouseEvent.GetScreenSpacePosition());
    const FVector2D World = (Local - PanOffset) / FMath::Max(Old, 0.001f);
    PanOffset = Local - World * Zoom;
    ApplyTransform();
    return FReply::Handled();
}

// ── Palette ────────────────────────────────────────────────────────────────

FLinearColor SHaybaMCPSceneMapPanel::ColorForSemantic(EHaybaNodeSemantic S)
{
    switch (S)
    {
        case EHaybaNodeSemantic::Foliage:    return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Foliage");
        case EHaybaNodeSemantic::Building:   return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Building");
        case EHaybaNodeSemantic::Light:      return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Light");
        case EHaybaNodeSemantic::Trigger:    return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Trigger");
        case EHaybaNodeSemantic::Character:  return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Character");
        case EHaybaNodeSemantic::Blueprint:  return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Blueprint");
        default:                             return FHaybaMCPStyle::Colour("Hayba.Color.Semantic.Unknown");
    }
}
