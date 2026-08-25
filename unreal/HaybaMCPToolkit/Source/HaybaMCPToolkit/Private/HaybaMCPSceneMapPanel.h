#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "HaybaMCPSceneMapData.h"

class SCanvas;
class SBox;
class SBorder;

/**
 * Cognitive Map view (spec §3.2). Renders the level as a small set of
 * semantically-labelled AABB cells, one SBorder widget per cell positioned
 * absolutely in an inner SCanvas. Pan / zoom via RenderTransform on the
 * canvas wrapper. Click a cell to select its actors.
 */
class SHaybaMCPSceneMapPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSceneMapPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Re-scan the active world and rebuild the cognitive map cells. */
    void Refresh();

    /** Center pan + reset zoom so all cells fit in the viewport. */
    void FitView();

    /** Reset pan to origin and zoom to 1×. */
    void ResetView();

    int32 GetCellCount() const { return Cells.Num(); }

    // Compat shim: the rest of the codebase calls this; keep the signature so
    // we don't break references in HaybaMCPCommandHandler / HaybaMCPModule.
    void SelectActorById(const FString&) {}

protected:
    virtual FReply OnMouseMove(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FReply OnMouseWheel(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual void Tick(const FGeometry& AllottedGeometry, const double InCurrentTime, const float InDeltaTime) override;

private:
    TArray<FHaybaCogMapCell> Cells;

    TSharedPtr<SBox>    Viewport;
    TSharedPtr<SCanvas> CanvasInner;

    // View transform — applied to the inner canvas via SetRenderTransform.
    FVector2D PanOffset = FVector2D::ZeroVector;
    float     Zoom = 1.f;

    // Cached viewport size (px) tracked in Tick so FitView has accurate geom.
    FVector2D LastViewportSize = FVector2D(800.f, 600.f);

    void RebuildCanvas();
    void ApplyTransform();
    TSharedRef<SWidget> BuildCellWidget(int32 CellIndex);
    void OnCellClicked(int32 CellIndex);

    static FLinearColor ColorForSemantic(EHaybaNodeSemantic S);
};
