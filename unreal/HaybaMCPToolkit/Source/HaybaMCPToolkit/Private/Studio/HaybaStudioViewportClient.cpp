#include "Studio/HaybaStudioViewportClient.h"
#include "Studio/SHaybaStudioViewport.h"
#include "AdvancedPreviewScene.h"
#include "EditorModeManager.h"
#include "SceneManagement.h"

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

void FHaybaStudioViewportClient::Draw(const FSceneView* View, FPrimitiveDrawInterface* PDI)
{
    FEditorViewportClient::Draw(View, PDI);

    for (const FHaybaMaskDrawItem& Item : MaskItems)
    {
        const float Thickness = Item.bSelected ? 3.0f : 1.5f;
        const FLinearColor Color = Item.bSelected ? (Item.Color * 1.6f) : Item.Color;
        if (Item.bSphere)
        {
            // Translucent fill (uniform) so the volume reads from inside; coloured wire on top.
            if (FillProxy)
            {
                DrawSphere(PDI, Item.Center, FRotator::ZeroRotator, FVector(Item.Radius), 24, 12, FillProxy, SDPG_World);
            }
            DrawWireSphere(PDI, Item.Center, Color, Item.Radius, 24, SDPG_World, Thickness);
        }
        else
        {
            if (FillProxy)
            {
                DrawBox(PDI, FTranslationMatrix(Item.Center), Item.Extents, FillProxy, SDPG_World);
            }
            const FBox Box(Item.Center - Item.Extents, Item.Center + Item.Extents);
            DrawWireBox(PDI, Box, Color, SDPG_World, Thickness);
        }
    }
}
