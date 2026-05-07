#pragma once
#include "CoreMinimal.h"
#include "Widgets/SLeafWidget.h"
#include "HaybaMCPSceneMapData.h"

class SHaybaMCPSceneMapPanel : public SLeafWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSceneMapPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SHaybaMCPSceneMapPanel();

    void LoadSceneGraph(const TArray<FHaybaSceneNode>& InNodes, const TArray<FHaybaSceneEdge>& InEdges);
    void SelectActorById(const FString& ActorId);

protected:
    virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& AllottedGeometry,
        const FSlateRect& MyCullingRect, FSlateWindowElementList& OutDrawElements,
        int32 LayerId, const FWidgetStyle& InWidgetStyle, bool bParentEnabled) const override;

    virtual FVector2D ComputeDesiredSize(float) const override { return FVector2D(400.f, 300.f); }
    virtual FReply OnMouseButtonDown(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FReply OnMouseMove(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual FReply OnMouseWheel(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent) override;
    virtual bool ComputeVolatility() const override { return false; }

private:
    TArray<FHaybaSceneNode> Nodes;
    TArray<FHaybaSceneEdge> Edges;
    TUniquePtr<FHaybaQuadtreeNode> Quadtree;

    FVector2D PanOffset = FVector2D::ZeroVector;
    float Zoom = 1.0f;

    FDelegateHandle SelectionDelegateHandle;

    FVector2D WorldToScreen(FVector2D WorldPos, const FGeometry& Geom) const;
    FVector2D ScreenToWorld(FVector2D ScreenPos, const FGeometry& Geom) const;
    FBox2D GetViewportWorldBounds(const FGeometry& Geom) const;

    static FColor GetColorForSemantic(EHaybaNodeSemantic S);
    void AppendNodeQuad(TArray<FSlateVertex>& Verts, TArray<SlateIndex>& Indices,
        FVector2D Center, FVector2D HalfSize, FColor Color) const;

    void RebuildQuadtree();
    void OnEditorSelectionChanged(UObject* SelectionObj);
};
