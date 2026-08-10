#include "HaybaMCPCaptureActor.h"
#include "HaybaMCPRenderSafety.h"
#include "Engine/TextureRenderTarget2D.h"
#include "ImageUtils.h"
#include "Misc/Base64.h"
#include "Misc/ScopeExit.h"

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

FString AHaybaMCPCaptureActor::CaptureToBase64(
    int32 W, int32 H,
    const TSharedPtr<HaybaRenderSafety::FLease, ESPMode::ThreadSafe>& Lease,
    FString* OutError)
{
    auto Fail = [OutError](const FString& Error)
    {
        if (OutError) *OutError = Error;
        return FString();
    };
    if (!IsInGameThread()) return Fail(TEXT("editor_capture_viewport must run on the game thread"));
    if (!IsValid(Capture)) return Fail(TEXT("capture actor has no valid SceneCaptureComponent2D"));

    FString Error;
    int32 SafeWidth = 0;
    int32 SafeHeight = 0;
    if (!HaybaRenderSafety::ValidateDimensions(
        W, H, SafeWidth, SafeHeight, Error, HaybaRenderSafety::MaxInlinePixels))
    {
        return Fail(Error + TEXT("; inline viewport captures are capped at 1920x1080 pixels"));
    }
    if (!Lease.IsValid()) return Fail(Error);
    if (!Lease->Advance(HaybaRenderSafety::EStage::AllocatingTarget, Error)) return Fail(Error);

    UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>(this);
    if (!RT) return Fail(TEXT("render-target allocation returned null"));
    UTextureRenderTarget2D* PreviousTarget = Capture->TextureTarget;
    ON_SCOPE_EXIT
    {
        if (IsValid(Capture)) Capture->TextureTarget = PreviousTarget;
        if (IsValid(RT))
        {
            RT->ReleaseResource();
            FlushRenderingCommands();
        }
    };

    RT->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
    RT->InitAutoFormat(SafeWidth, SafeHeight);
    RT->UpdateResourceImmediate(true);
    Capture->TextureTarget = RT;
    if (!Lease->Advance(HaybaRenderSafety::EStage::Capturing, Error)) return Fail(Error);
    Capture->CaptureScene();
    FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
    if (!Res) return Fail(TEXT("render target has no game-thread resource"));
    if (!Lease->Advance(HaybaRenderSafety::EStage::ReadingBack, Error)) return Fail(Error);
    TArray<FColor> Pixels;
    if (!Res->ReadPixels(Pixels) || Pixels.Num() != int64(SafeWidth) * int64(SafeHeight))
    {
        return Fail(FString::Printf(TEXT("pixel readback returned %d pixels, expected %lld"),
            Pixels.Num(), int64(SafeWidth) * int64(SafeHeight)));
    }
    if (!Lease->Advance(HaybaRenderSafety::EStage::Encoding, Error)) return Fail(Error);
    TArray64<uint8> Png;
    FImageUtils::PNGCompressImageArray(SafeWidth, SafeHeight, Pixels, Png);
    if (!HaybaRenderSafety::VerifyEncodedImage(Png, TEXT("png"), SafeWidth, SafeHeight, Error))
        return Fail(Error);
    if (!Lease->Advance(HaybaRenderSafety::EStage::Complete, Error)) return Fail(Error);

    TArray<uint8> Narrow;
    Narrow.Append(Png.GetData(), int32(Png.Num()));
    return FBase64::Encode(Narrow);
}
