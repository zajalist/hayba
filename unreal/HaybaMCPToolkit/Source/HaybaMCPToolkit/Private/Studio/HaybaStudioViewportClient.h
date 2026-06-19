#pragma once
#include "CoreMinimal.h"
#include "EditorViewportClient.h"

class FAdvancedPreviewScene;
class FEditorModeTools;
class SHaybaStudioViewport;

// Viewport client for the Semantic Studio preview. B3 just renders the mesh;
// mask overlays (volume shapes / surface triangles) are drawn here in B4/B5.
class FHaybaStudioViewportClient : public FEditorViewportClient
{
public:
    FHaybaStudioViewportClient(FEditorModeTools* InModeTools,
                               FAdvancedPreviewScene* InPreviewScene,
                               const TSharedRef<SHaybaStudioViewport>& InViewport);
};
