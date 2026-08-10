#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/SceneCaptureComponent2D.h"
#include "HaybaMCPRenderSafety.h"
#include "HaybaMCPCaptureActor.generated.h"

UCLASS()
class AHaybaMCPCaptureActor : public AActor
{
    GENERATED_BODY()
public:
    AHaybaMCPCaptureActor();

    UPROPERTY(VisibleAnywhere, Category = "Hayba MCP")
    USceneCaptureComponent2D* Capture;

    /** Move to match active viewport, capture, return base64-encoded PNG.
     *  OutError distinguishes policy/RHI/readback failures from an empty image. */
    FString CaptureToBase64(
        int32 Width, int32 Height,
        const TSharedPtr<HaybaRenderSafety::FLease, ESPMode::ThreadSafe>& Lease,
        FString* OutError = nullptr);
};
