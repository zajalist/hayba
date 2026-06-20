#include "Studio/HaybaStudioViewportClient.h"
#include "Studio/SHaybaStudioViewport.h"
#include "AdvancedPreviewScene.h"
#include "EditorModeManager.h"
#include "SceneManagement.h"
#include "DynamicMeshBuilder.h"

FHaybaStudioViewportClient::FHaybaStudioViewportClient(FEditorModeTools* InModeTools,
                                                       FAdvancedPreviewScene* InPreviewScene,
                                                       const TSharedRef<SHaybaStudioViewport>& InViewport)
    : FEditorViewportClient(InModeTools, InPreviewScene, StaticCastSharedRef<SEditorViewport>(InViewport))
{
    SetViewMode(VMI_Lit);
    SetRealtime(true);

    // Temporal AA shimmers on thin overlay lines (reads as "blinking"); turn it
    // off for a stable preview.
    EngineShowFlags.SetTemporalAA(false);
    EngineShowFlags.SetMotionBlur(false);

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

// A wire box whose 12 edges carry a depth bias + thickness, so edges that sit
// coplanar with a surface (e.g. the box bottom resting on the floor) render
// cleanly on top instead of z-fighting the surface texture.
static void DrawBiasedWireBox(FPrimitiveDrawInterface* PDI, const FVector& C, const FVector& E,
                              const FLinearColor& Color, float Thickness, float DepthBias)
{
    const FVector P[8] = {
        C + FVector(-E.X, -E.Y, -E.Z), C + FVector( E.X, -E.Y, -E.Z),
        C + FVector( E.X,  E.Y, -E.Z), C + FVector(-E.X,  E.Y, -E.Z),
        C + FVector(-E.X, -E.Y,  E.Z), C + FVector( E.X, -E.Y,  E.Z),
        C + FVector( E.X,  E.Y,  E.Z), C + FVector(-E.X,  E.Y,  E.Z),
    };
    static const int32 Edges[12][2] = {
        {0,1},{1,2},{2,3},{3,0}, {4,5},{5,6},{6,7},{7,4}, {0,4},{1,5},{2,6},{3,7}
    };
    for (const auto& Ed : Edges)
    {
        // Foreground depth group: drawn on top without a depth test, so edges
        // coplanar with a surface (box bottom on the floor) cannot z-fight it.
        PDI->DrawLine(P[Ed[0]], P[Ed[1]], Color, SDPG_Foreground, Thickness, DepthBias);
    }
}

void FHaybaStudioViewportClient::Draw(const FSceneView* View, FPrimitiveDrawInterface* PDI)
{
    FEditorViewportClient::Draw(View, PDI);

    // Volume masks — per-mask translucent solid + coloured wire on top.
    for (const FHaybaMaskDrawItem& Item : MaskItems)
    {
        const float Thickness = Item.bSelected ? 4.0f : 2.0f;
        const float DepthBias = 2.0f;   // lifts coplanar edges off surfaces (anti z-fight)
        const FLinearColor Color = Item.bSelected ? (Item.Color * 1.6f) : Item.Color;
        if (Item.bSphere)
        {
            if (Item.FillProxy) DrawSphere(PDI, Item.Center, FRotator::ZeroRotator, FVector(Item.Radius), 24, 12, Item.FillProxy, SDPG_World);
            DrawWireSphere(PDI, Item.Center, Color, Item.Radius, 24, SDPG_World, Thickness, DepthBias);
        }
        else
        {
            if (Item.FillProxy) DrawBox(PDI, FTranslationMatrix(Item.Center), Item.Extents, Item.FillProxy, SDPG_World);
            DrawBiasedWireBox(PDI, Item.Center, Item.Extents, Color, Thickness, DepthBias);
        }
    }

    // Surface masks — a translucent coloured fill laid directly on the mesh
    // faces, nudged slightly along the triangle normal to avoid z-fighting.
    for (const FHaybaSurfaceTri& Tri : SurfaceTris)
    {
        if (!Tri.FillProxy) continue;
        FVector N = FVector::CrossProduct(Tri.B - Tri.A, Tri.C - Tri.A);
        N = N.GetSafeNormal();
        const FVector Offset = N * (Tri.bSelected ? 0.6f : 0.4f);  // cm

        FDynamicMeshBuilder MeshBuilder(View->GetFeatureLevel());
        FDynamicMeshVertex V0(FVector3f(Tri.A + Offset));
        FDynamicMeshVertex V1(FVector3f(Tri.B + Offset));
        FDynamicMeshVertex V2(FVector3f(Tri.C + Offset));
        MeshBuilder.AddVertex(V0);
        MeshBuilder.AddVertex(V1);
        MeshBuilder.AddVertex(V2);
        MeshBuilder.AddTriangle(0, 1, 2);   // front face only — back winding let you see the mask through the mesh interior
        MeshBuilder.Draw(PDI, FMatrix::Identity, Tri.FillProxy, SDPG_World);
    }
}
