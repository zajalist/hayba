#include "Studio/HaybaStudioViewportClient.h"
#include "Studio/SHaybaStudioViewport.h"
#include "AdvancedPreviewScene.h"
#include "EditorModeManager.h"

FHaybaStudioViewportClient::FHaybaStudioViewportClient(FEditorModeTools* InModeTools,
                                                       FAdvancedPreviewScene* InPreviewScene,
                                                       const TSharedRef<SHaybaStudioViewport>& InViewport)
    : FEditorViewportClient(InModeTools, InPreviewScene, StaticCastSharedRef<SEditorViewport>(InViewport))
{
    SetViewMode(VMI_Lit);
    SetRealtime(true);

    // A pleasant default orbit framing the asset.
    SetViewLocation(FVector(250.f, 250.f, 180.f));
    SetViewRotation(FRotator(-20.f, 225.f, 0.f));

    EngineShowFlags.SetGrid(true);
    bSetListenerPosition = false;
    if (InPreviewScene)
    {
        InPreviewScene->SetFloorVisibility(true);
    }
}
