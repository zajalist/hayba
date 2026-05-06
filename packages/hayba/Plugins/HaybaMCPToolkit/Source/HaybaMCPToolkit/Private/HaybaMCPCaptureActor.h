#pragma once
#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/SceneCaptureComponent2D.h"
#include "HaybaMCPCaptureActor.generated.h"

UCLASS()
class AHaybaMCPCaptureActor : public AActor
{
    GENERATED_BODY()
public:
    AHaybaMCPCaptureActor();

    UPROPERTY(VisibleAnywhere)
    USceneCaptureComponent2D* Capture;

    UPROPERTY(VisibleAnywhere)
    UTextureRenderTarget2D* RT;

    /** Move to match active viewport, capture, return base64-encoded PNG. */
    FString CaptureToBase64(int32 Width = 1280, int32 Height = 720);
};
