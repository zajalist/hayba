#include "Studio/SHaybaStudioViewport.h"
#include "Studio/HaybaStudioViewportClient.h"
#include "AssetEditorModeManager.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"

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

void SHaybaStudioViewport::AddReferencedObjects(FReferenceCollector& Collector)
{
    Collector.AddReferencedObject(PreviewComponent);
}
