#include "HaybaMCPCaptureActor.h"
#include "Engine/TextureRenderTarget2D.h"
#include "ImageUtils.h"
#include "Misc/Base64.h"

AHaybaMCPCaptureActor::AHaybaMCPCaptureActor()
{
    PrimaryActorTick.bCanEverTick = false;
    Capture = CreateDefaultSubobject<USceneCaptureComponent2D>(TEXT("Capture"));
    RootComponent = Capture;
    Capture->bCaptureEveryFrame = false;
    Capture->bCaptureOnMovement = false;
    Tags.Add(FName(TEXT("HaybaMCPCaptureActor")));
}

FString AHaybaMCPCaptureActor::CaptureToBase64(int32 W, int32 H)
{
    if (!RT || RT->SizeX != W || RT->SizeY != H)
    {
        RT = NewObject<UTextureRenderTarget2D>(this);
        RT->InitAutoFormat(W, H);
        RT->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
        RT->UpdateResourceImmediate(true);
        Capture->TextureTarget = RT;
    }
    Capture->CaptureScene();
    FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
    if (!Res) return FString();
    TArray<FColor> Pixels;
    Res->ReadPixels(Pixels);
    TArray<uint8> PNG;
    FImageUtils::ThumbnailCompressImageArray(W, H, Pixels, PNG);
    return FBase64::Encode(PNG);
}
