#pragma once

#include "CoreMinimal.h"

class FTextureRenderTargetResource;

/** One-shot RGBA32f render-target readback. GPU copy and staging-map stay on
 * the render thread; the editor thread only polls an atomic completion flag. */
class FHaybaWorldDepthReadback final : public TSharedFromThis<FHaybaWorldDepthReadback, ESPMode::ThreadSafe>
{
public:
    static TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> Start(
        FTextureRenderTargetResource* Resource);
    void Poll();
    bool IsComplete() const;
    bool TakePixels(TArray<FLinearColor>& OutPixels, double& OutCopyMs);

private:
    struct FRenderState;
    TSharedPtr<FRenderState, ESPMode::ThreadSafe> State;
};
