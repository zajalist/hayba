#include "Studio/SHaybaStudioViewport.h"
#include "Studio/HaybaStudioViewportClient.h"
#include "AssetEditorModeManager.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/Engine.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "StaticMeshResources.h"

void SHaybaStudioViewport::Construct(const FArguments& InArgs)
{
    PreviewScene = MakeShared<FAdvancedPreviewScene>(FPreviewScene::ConstructionValues());
    // Isolated mode manager bound to the preview scene — keeps the client from
    // bleeding into the global level-editor selection/gizmo (which made the
    // transform widget hijack camera input). No active mode = orbit-only preview.
    ModeManager = MakeShared<FAssetEditorModeManager>();
    ModeManager->SetPreviewScene(PreviewScene.Get());

    PreviewComponent = NewObject<UStaticMeshComponent>();
    PreviewScene->AddComponent(PreviewComponent, FTransform::Identity);

    SEditorViewport::Construct(SEditorViewport::FArguments());
}

SHaybaStudioViewport::~SHaybaStudioViewport()
{
    if (ViewportClient.IsValid())
    {
        ViewportClient->Viewport = nullptr;
    }
}

TSharedRef<FEditorViewportClient> SHaybaStudioViewport::MakeEditorViewportClient()
{
    ViewportClient = MakeShared<FHaybaStudioViewportClient>(ModeManager.Get(), PreviewScene.Get(), SharedThis(this));
    return ViewportClient.ToSharedRef();
}

void SHaybaStudioViewport::SetPreviewMesh(UStaticMesh* Mesh)
{
    if (!PreviewComponent) return;
    PreviewComponent->SetStaticMesh(Mesh);

    // Seat the mesh on the preview floor (z=0): lift it so the bounds bottom
    // rests on the ground instead of the pivot sinking half the mesh below it.
    float ZOffset = 0.f;
    if (Mesh)
    {
        const FBoxSphereBounds B = Mesh->GetBounds();
        ZOffset = B.BoxExtent.Z - B.Origin.Z;
    }
    PreviewComponent->SetWorldLocation(FVector(0.f, 0.f, ZOffset));
    PreviewComponent->MarkRenderStateDirty();
}

UMaterialInstanceDynamic* SHaybaStudioViewport::GetColorFill(const FLinearColor& Color)
{
    const FString Key = Color.ToFColor(true).ToHex();
    if (TObjectPtr<UMaterialInstanceDynamic>* Found = FillMaterials.Find(Key))
    {
        return *Found;
    }
    if (!GEngine || !GEngine->GeomMaterial) return nullptr;
    UMaterialInstanceDynamic* MID = UMaterialInstanceDynamic::Create(GEngine->GeomMaterial, GetTransientPackage());
    if (MID)
    {
        // GeomMaterial is the engine's translucent debug material; its "Color"
        // vector param drives both tint and (alpha) translucency.
        MID->SetVectorParameterValue(TEXT("Color"), FLinearColor(Color.R, Color.G, Color.B, 0.35f));
        FillMaterials.Add(Key, MID);
    }
    return MID;
}

void SHaybaStudioViewport::SetMasks(const TArray<FHaybaStudioMask>& Masks, const TSet<FString>& Hidden, const FString& SelectedId)
{
    if (!ViewportClient.IsValid()) return;

    const FVector Base = PreviewComponent ? PreviewComponent->GetComponentLocation() : FVector::ZeroVector;
    constexpr float M_TO_CM = 100.f;

    TArray<FHaybaMaskDrawItem> Items;
    for (const FHaybaStudioMask& M : Masks)
    {
        if (M.Type != TEXT("volume") || !M.bHasShape) continue;   // surface masks → B5
        if (Hidden.Contains(M.Id)) continue;

        FHaybaMaskDrawItem Item;
        Item.Color = M.Color;
        Item.bSelected = (M.Id == SelectedId);
        if (UMaterialInstanceDynamic* Fill = GetColorFill(M.Color)) Item.FillProxy = Fill->GetRenderProxy();
        Item.Center = Base + M.Shape.Pos * M_TO_CM;
        if (M.Shape.Kind == TEXT("sphere"))
        {
            Item.bSphere = true;
            Item.Radius = M.Shape.Radius * M_TO_CM;
        }
        else
        {
            Item.Extents = M.Shape.Extents * M_TO_CM;
        }
        Items.Add(Item);
    }

    // ── Surface masks → highlighted mesh triangles ──────────────────────────
    TArray<FHaybaSurfaceTri> Tris;
    UStaticMesh* Mesh = PreviewComponent ? PreviewComponent->GetStaticMesh() : nullptr;
    if (Mesh && Mesh->GetRenderData() && Mesh->GetRenderData()->LODResources.Num() > 0)
    {
        const FTransform CompXf = PreviewComponent->GetComponentTransform();
        const FStaticMeshLODResources& LOD = Mesh->GetRenderData()->LODResources[0];
        const FPositionVertexBuffer& PosBuf = LOD.VertexBuffers.PositionVertexBuffer;
        FIndexArrayView IndexView = LOD.IndexBuffer.GetArrayView();
        const int32 TriCount = IndexView.Num() / 3;

        auto WorldPos = [&](uint32 VertIdx) -> FVector
        {
            return CompXf.TransformPosition(FVector(PosBuf.VertexPosition(VertIdx)));
        };

        for (const FHaybaStudioMask& M : Masks)
        {
            if (M.Type != TEXT("surface")) continue;
            if (Hidden.Contains(M.Id)) continue;
            const bool bSel = (M.Id == SelectedId);
            for (int32 T : M.Triangles)
            {
                if (T < 0 || T >= TriCount) continue;
                FHaybaSurfaceTri Tri;
                Tri.A = WorldPos(IndexView[T * 3 + 0]);
                Tri.B = WorldPos(IndexView[T * 3 + 1]);
                Tri.C = WorldPos(IndexView[T * 3 + 2]);
                Tri.Color = M.Color;
                Tri.bSelected = bSel;
                if (UMaterialInstanceDynamic* Fill = GetColorFill(M.Color)) Tri.FillProxy = Fill->GetRenderProxy();
                Tris.Add(Tri);
            }
        }
    }

    ViewportClient->SetMaskDrawItems(MoveTemp(Items));
    ViewportClient->SetSurfaceTris(MoveTemp(Tris));
    ViewportClient->Invalidate();
}

void SHaybaStudioViewport::AddReferencedObjects(FReferenceCollector& Collector)
{
    Collector.AddReferencedObject(PreviewComponent);
    for (auto& Pair : FillMaterials)
    {
        Collector.AddReferencedObject(Pair.Value);
    }
}
