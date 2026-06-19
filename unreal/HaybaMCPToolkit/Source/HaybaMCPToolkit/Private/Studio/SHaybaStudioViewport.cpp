#include "Studio/SHaybaStudioViewport.h"
#include "Studio/HaybaStudioViewportClient.h"
#include "AssetEditorModeManager.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/Engine.h"
#include "Materials/MaterialInstanceDynamic.h"

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

    // Translucent fill material for the volume-mask overlays (so a box reads as a
    // volume from inside). EditorBrushMaterial is the engine's translucent brush
    // material — a safe, always-present parent.
    if (GEngine && GEngine->EditorBrushMaterial)
    {
        FillMaterial = UMaterialInstanceDynamic::Create(GEngine->EditorBrushMaterial, GetTransientPackage());
    }

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

    ViewportClient->SetFillMaterial(FillMaterial ? FillMaterial->GetRenderProxy() : nullptr);
    ViewportClient->SetMaskDrawItems(MoveTemp(Items));
    ViewportClient->Invalidate();
}

void SHaybaStudioViewport::AddReferencedObjects(FReferenceCollector& Collector)
{
    Collector.AddReferencedObject(PreviewComponent);
    Collector.AddReferencedObject(FillMaterial);
}
