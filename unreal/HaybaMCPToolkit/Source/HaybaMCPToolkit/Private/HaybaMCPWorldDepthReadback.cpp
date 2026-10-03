#include "HaybaMCPWorldDepthReadback.h"

#include "HaybaMCPWorldDepth.h"
#include "HAL/PlatformTime.h"
#include "RHIGPUReadback.h"
#include "RenderingThread.h"
#include "UnrealClient.h"

#include <atomic>

struct FHaybaWorldDepthReadback::FRenderState
{
    // Only the render thread reads or writes Readback, Pixels and CopyMs until
    // Complete is published with release ordering. The game thread then owns
    // the finished result.
    TUniquePtr<FRHIGPUTextureReadback> Readback;
    TArray<FLinearColor> Pixels;
    double CopyMs = 0.0;
    std::atomic<bool> PollQueued{false};
    std::atomic<bool> Complete{false};
};

TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe>
FHaybaWorldDepthReadback::Start(FTextureRenderTargetResource* Resource)
{
    check(IsInGameThread());
    if (!Resource) return nullptr;

    TSharedPtr<FHaybaWorldDepthReadback, ESPMode::ThreadSafe> Request =
        MakeShared<FHaybaWorldDepthReadback, ESPMode::ThreadSafe>();
    Request->State = MakeShared<FRenderState, ESPMode::ThreadSafe>();
    const TSharedPtr<FRenderState, ESPMode::ThreadSafe> State = Request->State;
    // CaptureScene's render command was queued before this copy. The RHI texture
    // is owned by the render thread and may still be null on the game thread.
    // A later ReleaseResource command also follows this one in queue order.
    ENQUEUE_RENDER_COMMAND(HaybaDepthQueueReadback)(
        [State, Resource](FRHICommandListImmediate& RHICmdList)
        {
            const FTextureRHIRef Texture = Resource->GetRenderTargetTexture();
            if (!Texture.IsValid() || Texture->GetFormat() != PF_A32B32G32R32F ||
                Texture->GetSizeXY() != FIntPoint(HaybaWorldDepth::Width, HaybaWorldDepth::Height))
            {
                UE_LOG(LogTemp, Warning,
                    TEXT("Hayba World depth capture has no compatible RGBA32f render texture"));
                State->Complete.store(true, std::memory_order_release);
                return;
            }
            State->Readback = MakeUnique<FRHIGPUTextureReadback>(TEXT("HaybaWorldDepth"));
            State->Readback->EnqueueCopy(RHICmdList, Texture.GetReference());
        });
    return Request;
}

void FHaybaWorldDepthReadback::Poll()
{
    check(IsInGameThread());
    if (!State.IsValid() || State->Complete.load(std::memory_order_acquire) ||
        State->PollQueued.exchange(true, std::memory_order_acq_rel)) return;
    const TSharedPtr<FRenderState, ESPMode::ThreadSafe> Local = State;
    ENQUEUE_RENDER_COMMAND(HaybaDepthPollReadback)(
        [Local](FRHICommandListImmediate&)
        {
            if (Local->Readback.IsValid() && Local->Readback->IsReady())
            {
                const double Started = FPlatformTime::Seconds();
                int32 RowPitch = 0, BufferHeight = 0;
                const FLinearColor* Data = static_cast<const FLinearColor*>(
                    Local->Readback->Lock(RowPitch, &BufferHeight));
                if (Data && RowPitch >= HaybaWorldDepth::Width &&
                    BufferHeight >= HaybaWorldDepth::Height)
                {
                    Local->Pixels.SetNumUninitialized(HaybaWorldDepth::MaxPoints);
                    for (int32 Y = 0; Y < HaybaWorldDepth::Height; ++Y)
                        FMemory::Memcpy(Local->Pixels.GetData() + Y * HaybaWorldDepth::Width,
                            Data + Y * RowPitch,
                            HaybaWorldDepth::Width * sizeof(FLinearColor));
                }
                if (Data) Local->Readback->Unlock();
                Local->CopyMs = (FPlatformTime::Seconds() - Started) * 1000.0;
                Local->Readback.Reset();
                Local->Complete.store(true, std::memory_order_release);
            }
            Local->PollQueued.store(false, std::memory_order_release);
        });
}

bool FHaybaWorldDepthReadback::IsComplete() const
{
    return State.IsValid() && State->Complete.load(std::memory_order_acquire);
}

bool FHaybaWorldDepthReadback::TakePixels(TArray<FLinearColor>& OutPixels, double& OutCopyMs)
{
    check(IsInGameThread());
    if (!IsComplete()) return false;
    OutPixels = MoveTemp(State->Pixels);
    OutCopyMs = State->CopyMs;
    State.Reset();
    return OutPixels.Num() == HaybaWorldDepth::MaxPoints;
}
