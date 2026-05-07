#include "HaybaMCPSceneMapPanel.h"
#include "Rendering/DrawElements.h"
#include "Framework/Application/SlateApplication.h"
#include "Styling/AppStyle.h"
#include "Engine/Selection.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"

void FHaybaQuadtreeNode::Insert(int32 Idx, FVector2D Pos, int32 Depth)
{
    if (bLeaf)
    {
        Entries.Add({ Idx, Pos });
        if (Entries.Num() > MaxPerLeaf && Depth < MaxDepth)
        {
            const FVector2D Mid = Bounds.GetCenter();
            Children[0] = MakeUnique<FHaybaQuadtreeNode>(); Children[0]->Bounds = FBox2D(Bounds.Min, Mid);
            Children[1] = MakeUnique<FHaybaQuadtreeNode>(); Children[1]->Bounds = FBox2D(FVector2D(Mid.X, Bounds.Min.Y), FVector2D(Bounds.Max.X, Mid.Y));
            Children[2] = MakeUnique<FHaybaQuadtreeNode>(); Children[2]->Bounds = FBox2D(Mid, Bounds.Max);
            Children[3] = MakeUnique<FHaybaQuadtreeNode>(); Children[3]->Bounds = FBox2D(FVector2D(Bounds.Min.X, Mid.Y), FVector2D(Mid.X, Bounds.Max.Y));
            bLeaf = false;
            TArray<FHaybaQuadtreeEntry> Old = MoveTemp(Entries);
            for (const auto& E : Old)
            {
                bool bPlaced = false;
                for (auto& C : Children)
                {
                    if (C && C->Bounds.IsInside(E.Pos)) { C->Insert(E.Idx, E.Pos, Depth + 1); bPlaced = true; break; }
                }
                if (!bPlaced) Entries.Add(E); // straddler stays in parent
            }
        }
        return;
    }
    for (auto& C : Children)
    {
        if (C && C->Bounds.IsInside(Pos)) { C->Insert(Idx, Pos, Depth + 1); return; }
    }
    Entries.Add({ Idx, Pos });
}

void FHaybaQuadtreeNode::Query(const FBox2D& Rect, TArray<int32>& Out) const
{
    if (!Bounds.Intersect(Rect)) return;
    for (const auto& E : Entries)
    {
        if (Rect.IsInside(E.Pos)) Out.Add(E.Idx);
    }
    if (!bLeaf)
    {
        for (const auto& C : Children) if (C) C->Query(Rect, Out);
    }
}

void SHaybaMCPSceneMapPanel::Construct(const FArguments& InArgs)
{
    SelectionDelegateHandle = USelection::SelectionChangedEvent.AddRaw(
        this, &SHaybaMCPSceneMapPanel::OnEditorSelectionChanged);
}

SHaybaMCPSceneMapPanel::~SHaybaMCPSceneMapPanel()
{
    USelection::SelectionChangedEvent.Remove(SelectionDelegateHandle);
}

void SHaybaMCPSceneMapPanel::LoadSceneGraph(const TArray<FHaybaSceneNode>& InNodes, const TArray<FHaybaSceneEdge>& InEdges)
{
    Nodes = InNodes;
    Edges = InEdges;
    RebuildQuadtree();
    Invalidate(EInvalidateWidgetReason::Paint);
}

void SHaybaMCPSceneMapPanel::SelectActorById(const FString& ActorId)
{
    for (auto& N : Nodes) N.bSelected = (N.ActorId == ActorId);
    Invalidate(EInvalidateWidgetReason::Paint);
}

void SHaybaMCPSceneMapPanel::RebuildQuadtree()
{
    Quadtree.Reset();
    if (Nodes.IsEmpty()) return;
    FBox2D Bounds(ForceInit);
    for (const auto& N : Nodes) Bounds += N.WorldPos;
    Bounds = Bounds.ExpandBy(100.f);
    Quadtree = MakeUnique<FHaybaQuadtreeNode>();
    Quadtree->Bounds = Bounds;
    for (int32 i = 0; i < Nodes.Num(); i++) Quadtree->Insert(i, Nodes[i].WorldPos);
}

FColor SHaybaMCPSceneMapPanel::GetColorForSemantic(EHaybaNodeSemantic S)
{
    switch (S)
    {
        case EHaybaNodeSemantic::Foliage:    return FColor(34, 139, 34);
        case EHaybaNodeSemantic::Building:   return FColor(128, 128, 160);
        case EHaybaNodeSemantic::Light:      return FColor(255, 230, 80);
        case EHaybaNodeSemantic::Trigger:    return FColor(80, 200, 255);
        case EHaybaNodeSemantic::Character:  return FColor(255, 100, 100);
        case EHaybaNodeSemantic::Blueprint:  return FColor(180, 100, 255);
        default:                             return FColor(200, 200, 200);
    }
}

void SHaybaMCPSceneMapPanel::AppendNodeQuad(TArray<FSlateVertex>& Verts, TArray<SlateIndex>& Indices,
    FVector2D Center, FVector2D HalfSize, FColor Color) const
{
    const SlateIndex Base = (SlateIndex)Verts.Num();
    const FVector2f Corners[4] = {
        { (float)(Center.X - HalfSize.X), (float)(Center.Y - HalfSize.Y) },
        { (float)(Center.X + HalfSize.X), (float)(Center.Y - HalfSize.Y) },
        { (float)(Center.X + HalfSize.X), (float)(Center.Y + HalfSize.Y) },
        { (float)(Center.X - HalfSize.X), (float)(Center.Y + HalfSize.Y) },
    };
    for (const auto& C : Corners)
    {
        FSlateVertex V;
        V.Position = C;
        V.Color = Color;
        V.TexCoords[0] = V.TexCoords[1] = 0.5f;
        V.TexCoords[2] = V.TexCoords[3] = 0.0f;
        Verts.Add(V);
    }
    Indices.Append({ Base, (SlateIndex)(Base+1), (SlateIndex)(Base+2),
                     Base, (SlateIndex)(Base+2), (SlateIndex)(Base+3) });
}

int32 SHaybaMCPSceneMapPanel::OnPaint(const FPaintArgs& Args, const FGeometry& AllottedGeometry,
    const FSlateRect& MyCullingRect, FSlateWindowElementList& OutDrawElements,
    int32 LayerId, const FWidgetStyle& InWidgetStyle, bool bParentEnabled) const
{
    if (!Quadtree.IsValid() || Nodes.IsEmpty()) return LayerId;

    const FBox2D VisibleWorld = GetViewportWorldBounds(AllottedGeometry);
    TArray<int32> VisibleIndices;
    Quadtree->Query(VisibleWorld, VisibleIndices);

    TArray<FSlateVertex> Verts;
    TArray<SlateIndex> Indices;
    Verts.Reserve(VisibleIndices.Num() * 4);
    Indices.Reserve(VisibleIndices.Num() * 6);

    for (int32 Idx : VisibleIndices)
    {
        if (!Nodes.IsValidIndex(Idx)) continue;
        const FHaybaSceneNode& N = Nodes[Idx];
        const FVector2D ScreenPos = WorldToScreen(N.WorldPos, AllottedGeometry);
        FColor Color = GetColorForSemantic(N.Semantic);
        if (N.bSelected) Color = FColor(255, 200, 0);
        if (N.bHovered)  Color.A = 180;
        const FVector2D HalfSize = N.Size * Zoom * 0.5f;
        AppendNodeQuad(Verts, Indices, ScreenPos, HalfSize, Color);
    }

    if (Verts.Num() > 0)
    {
        const FSlateBrush* WhiteBrush = FAppStyle::Get().GetBrush("WhiteBrush");
        const FSlateResourceHandle Handle = FSlateApplication::Get().GetRenderer()->GetResourceHandle(*WhiteBrush);
        FSlateDrawElement::MakeCustomVerts(OutDrawElements, LayerId, Handle, Verts, Indices, nullptr, 0, 0);
    }

    return LayerId + 1;
}

FVector2D SHaybaMCPSceneMapPanel::WorldToScreen(FVector2D WorldPos, const FGeometry& Geom) const
{
    const FVector2D Local = (WorldPos + PanOffset) * Zoom;
    return Local + Geom.GetLocalSize() * 0.5;
}

FVector2D SHaybaMCPSceneMapPanel::ScreenToWorld(FVector2D ScreenPos, const FGeometry& Geom) const
{
    const FVector2D Centered = ScreenPos - Geom.GetLocalSize() * 0.5;
    return (Zoom != 0.f ? Centered / Zoom : Centered) - PanOffset;
}

FBox2D SHaybaMCPSceneMapPanel::GetViewportWorldBounds(const FGeometry& Geom) const
{
    const FVector2D TopLeft = ScreenToWorld(FVector2D::ZeroVector, Geom);
    const FVector2D BottomRight = ScreenToWorld(Geom.GetLocalSize(), Geom);
    return FBox2D(
        FVector2D(FMath::Min(TopLeft.X, BottomRight.X), FMath::Min(TopLeft.Y, BottomRight.Y)),
        FVector2D(FMath::Max(TopLeft.X, BottomRight.X), FMath::Max(TopLeft.Y, BottomRight.Y))
    );
}

FReply SHaybaMCPSceneMapPanel::OnMouseButtonDown(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (!Quadtree.IsValid() || MouseEvent.GetEffectingButton() != EKeys::LeftMouseButton)
        return FReply::Unhandled();

    const FVector2D LocalMouse = MyGeometry.AbsoluteToLocal(MouseEvent.GetScreenSpacePosition());
    const FVector2D WorldPos = ScreenToWorld(LocalMouse, MyGeometry);
    TArray<int32> Near;
    Quadtree->Query(FBox2D(WorldPos - FVector2D(20, 20), WorldPos + FVector2D(20, 20)), Near);

    float BestDist = 20.f;
    int32 BestIdx = INDEX_NONE;
    for (int32 Idx : Near)
    {
        if (!Nodes.IsValidIndex(Idx)) continue;
        const float D = FVector2D::Distance(Nodes[Idx].WorldPos, WorldPos);
        if (D < BestDist) { BestDist = D; BestIdx = Idx; }
    }

    if (BestIdx != INDEX_NONE && GEditor)
    {
        if (UWorld* World = GEditor->GetEditorWorldContext().World())
        {
            for (TActorIterator<AActor> It(World); It; ++It)
            {
                if (It->GetActorLabel() == Nodes[BestIdx].Label)
                {
                    GEditor->SelectNone(false, true);
                    GEditor->SelectActor(*It, true, true);
                    break;
                }
            }
        }
        for (auto& N : Nodes) N.bSelected = false;
        Nodes[BestIdx].bSelected = true;
        Invalidate(EInvalidateWidgetReason::Paint);
    }
    return FReply::Handled();
}

FReply SHaybaMCPSceneMapPanel::OnMouseMove(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    if (MouseEvent.IsMouseButtonDown(EKeys::RightMouseButton))
    {
        PanOffset += MouseEvent.GetCursorDelta() / FMath::Max(Zoom, 0.001f);
        Invalidate(EInvalidateWidgetReason::Paint);
    }
    return FReply::Unhandled();
}

FReply SHaybaMCPSceneMapPanel::OnMouseWheel(const FGeometry& MyGeometry, const FPointerEvent& MouseEvent)
{
    Zoom = FMath::Clamp(Zoom + MouseEvent.GetWheelDelta() * 0.1f, 0.05f, 10.f);
    Invalidate(EInvalidateWidgetReason::Paint);
    return FReply::Handled();
}

void SHaybaMCPSceneMapPanel::OnEditorSelectionChanged(UObject*)
{
    if (!GEditor) return;
    USelection* Sel = GEditor->GetSelectedActors();
    if (!Sel) return;
    TSet<FString> SelectedLabels;
    Sel->ForEachObjectOfClass(AActor::StaticClass(), [&](UObject* Obj)
    {
        if (AActor* A = Cast<AActor>(Obj)) SelectedLabels.Add(A->GetActorLabel());
    }, true);
    bool bChanged = false;
    for (auto& N : Nodes)
    {
        const bool bNow = SelectedLabels.Contains(N.Label);
        if (N.bSelected != bNow) { N.bSelected = bNow; bChanged = true; }
    }
    if (bChanged) Invalidate(EInvalidateWidgetReason::Paint);
}
