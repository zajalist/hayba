#include "Studio/SHaybaStudioViewport.h"
#include "Studio/HaybaStudioViewportClient.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"

void SHaybaStudioViewport::Construct(const FArguments& InArgs)
{
    PreviewScene = MakeShared<FAdvancedPreviewScene>(FPreviewScene::ConstructionValues());
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
    ViewportClient = MakeShared<FHaybaStudioViewportClient>(PreviewScene.Get(), SharedThis(this));
    return ViewportClient.ToSharedRef();
}

void SHaybaStudioViewport::SetPreviewMesh(UStaticMesh* Mesh)
{
    if (PreviewComponent)
    {
        PreviewComponent->SetStaticMesh(Mesh);
        PreviewComponent->MarkRenderStateDirty();
    }
}

void SHaybaStudioViewport::AddReferencedObjects(FReferenceCollector& Collector)
{
    Collector.AddReferencedObject(PreviewComponent);
}
