#pragma once
#include "CoreMinimal.h"
#include "EditorViewportClient.h"

class FAdvancedPreviewScene;
class FEditorModeTools;
class SHaybaStudioViewport;

// One resolved, world-space mask overlay to draw. The viewport builds these from
// the profile's masks (resolving local→world via the seated component); the
// client stays dumb and just renders them.
struct FHaybaMaskDrawItem
{
    bool         bSphere = false;
    FVector      Center = FVector::ZeroVector;   // world, cm
    FVector      Extents = FVector::ZeroVector;  // world half-size, cm (box)
    float        Radius = 0.f;                   // world, cm (sphere)
    FLinearColor Color = FLinearColor::White;
    bool         bSelected = false;
};

// Viewport client for the Semantic Studio preview. Renders the mesh plus the
// volume-mask overlays (B4). Surface-mask triangle overlays land in B5.
class FHaybaStudioViewportClient : public FEditorViewportClient
{
public:
    FHaybaStudioViewportClient(FEditorModeTools* InModeTools,
                               FAdvancedPreviewScene* InPreviewScene,
                               const TSharedRef<SHaybaStudioViewport>& InViewport);

    void SetMaskDrawItems(TArray<FHaybaMaskDrawItem> InItems) { MaskItems = MoveTemp(InItems); }
    void SetFillMaterial(const FMaterialRenderProxy* InProxy) { FillProxy = InProxy; }

    // FEditorViewportClient
    virtual void Draw(const FSceneView* View, FPrimitiveDrawInterface* PDI) override;

private:
    TArray<FHaybaMaskDrawItem> MaskItems;
    const FMaterialRenderProxy* FillProxy = nullptr;
};
