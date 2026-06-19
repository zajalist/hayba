#pragma once
#include "CoreMinimal.h"
#include "SEditorViewport.h"
#include "UObject/GCObject.h"
#include "AdvancedPreviewScene.h"
#include "Studio/HaybaStudioModel.h"

class UStaticMesh;
class UStaticMeshComponent;
class FHaybaStudioViewportClient;

// SEditorViewport hosting an AdvancedPreviewScene that shows one StaticMesh —
// the Semantic Studio's canvas. FGCObject keeps the preview component alive.
class SHaybaStudioViewport : public SEditorViewport, public FGCObject
{
public:
    SLATE_BEGIN_ARGS(SHaybaStudioViewport) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    virtual ~SHaybaStudioViewport() override;

    /** Set (or clear) the mesh shown in the preview. */
    void SetPreviewMesh(UStaticMesh* Mesh);

    /** Rebuild the volume-mask overlays from the profile masks (resolved to
     *  world space via the seated component). Hidden ids are skipped; the
     *  selected id draws emphasised. */
    void SetMasks(const TArray<FHaybaStudioMask>& Masks, const TSet<FString>& Hidden, const FString& SelectedId);

    // FGCObject
    virtual void AddReferencedObjects(FReferenceCollector& Collector) override;
    virtual FString GetReferencerName() const override { return TEXT("SHaybaStudioViewport"); }

protected:
    // SEditorViewport
    virtual TSharedRef<FEditorViewportClient> MakeEditorViewportClient() override;

private:
    TSharedPtr<FAdvancedPreviewScene> PreviewScene;
    TSharedPtr<class FAssetEditorModeManager> ModeManager;
    TSharedPtr<FHaybaStudioViewportClient> ViewportClient;
    TObjectPtr<UStaticMeshComponent> PreviewComponent = nullptr;
    TObjectPtr<class UMaterialInstanceDynamic> FillMaterial = nullptr;
};
