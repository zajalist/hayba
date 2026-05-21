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
    // Hide from editor + game viewports — this is internal plumbing for
    // the screenshot pipeline, not user-facing content. Without this the
    // actor shows up as a visible "blue spray bottle" in hero shots taken
    // from other angles (see mcp-architectural-issues #13).
    SetHidden(true);
    SetActorHiddenInGame(true);
    // Strip from cooked builds — we only need this in the editor.
    bIsEditorOnlyActor = true;
    // Tag for actor_list filtering. The legacy "HaybaMCPCaptureActor" tag
    // stays for any tooling that already searches by it.
    Tags.Add(FName(TEXT("HaybaMCPCaptureActor")));
    Tags.Add(FName(TEXT("HaybaMCP_Internal")));
    if (Capture)
    {
        Capture->SetVisibility(false, /*bPropagateToChildren=*/true);
        Capture->bHiddenInGame = true;
    }
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
