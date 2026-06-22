// HaybaMCPRenderHandler.cpp — see header.
//
// Threading: Handle() is invoked from the TCP server's per-request thread
// (NOT the game thread). All UWorld/UPCGComponent/SceneCapture touches must
// happen on the game thread, so we AsyncTask the render work and block the
// TCP thread on an FEvent until completion.

#include "HaybaMCPRenderHandler.h"
#include "HaybaMCPCaptureActor.h"

#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Components/SceneCaptureComponent2D.h"
#include "Camera/CameraComponent.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "ShaderCompiler.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/Guid.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectGlobals.h"

namespace HaybaRender
{
    constexpr double POLL_INTERVAL_SECONDS = 0.25;

    static bool IsShadersBusyImpl()
    {
        return GShaderCompilingManager && GShaderCompilingManager->IsCompiling();
    }
    static bool IsAssetsBusyImpl()
    {
        FAssetRegistryModule& Mod = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
        return Mod.Get().IsLoadingAssets();
    }

    static UWorld* ActiveEditorWorld()
    {
        if (GEditor)
        {
            UWorld* W = GEditor->GetEditorWorldContext().World();
            if (W) return W;
        }
        return GWorld;
    }

    static bool IsSubsystemBusy(const FString& Sub, uint64 StartFrameCounter, int32 WorldTicksRequired)
    {
        if (Sub == TEXT("shaders"))    return IsShadersBusyImpl();
        if (Sub == TEXT("assets"))     return IsAssetsBusyImpl();
        if (Sub == TEXT("world_tick")) return (GFrameCounter - StartFrameCounter) < (uint64)WorldTicksRequired;
        // 'gc' and 'pcg' are valid wait_for_idle subsystems but rarely needed
        // pre-render; we treat them as never-busy here to keep this handler
        // self-contained. Callers wanting full coverage can wait_for_idle first.
        return false;
    }

    static FString FormatTimestamp()
    {
        const FDateTime Now = FDateTime::Now();
        return FString::Printf(TEXT("%04d%02d%02d_%02d%02d%02d"),
            Now.GetYear(), Now.GetMonth(), Now.GetDay(),
            Now.GetHour(), Now.GetMinute(), Now.GetSecond());
    }

    static FString ResolveOutputPath(const FString& Requested, const FString& Format)
    {
        const FString Ext = (Format == TEXT("png")) ? TEXT("png")
                          : (Format == TEXT("exr")) ? TEXT("exr") : TEXT("jpg");
        FString Path = Requested;
        if (Path.IsEmpty())
        {
            const FString ScreenshotsDir = FPaths::ProjectSavedDir() / TEXT("Screenshots/Hayba");
            const FString Stamp = FormatTimestamp();
            const FString Uuid8 = FGuid::NewGuid().ToString(EGuidFormats::Digits).Left(8).ToLower();
            Path = ScreenshotsDir / FString::Printf(TEXT("hayba_%s_%s.%s"), *Stamp, *Uuid8, *Ext);
        }
        else if (FPaths::IsRelative(Path))
        {
            Path = FPaths::ProjectDir() / Path;
        }
        return FPaths::ConvertRelativePathToFull(Path);
    }

    /** Per-format magic byte check. Returns hex of first few bytes for error reporting. */
    static bool VerifyMagic(const TArray<uint8>& Bytes, const FString& Format, FString& OutHex)
    {
        OutHex.Reset();
        const int32 N = FMath::Min<int32>(Bytes.Num(), 12);
        for (int32 i = 0; i < N; i++)
        {
            OutHex += FString::Printf(TEXT("%02x"), Bytes[i]);
        }
        if (Bytes.Num() < 4) return false;
        if (Format == TEXT("png"))
        {
            return Bytes[0] == 0x89 && Bytes[1] == 0x50 && Bytes[2] == 0x4E && Bytes[3] == 0x47;
        }
        if (Format == TEXT("jpg"))
        {
            return Bytes[0] == 0xFF && Bytes[1] == 0xD8 && Bytes[2] == 0xFF;
        }
        if (Format == TEXT("exr"))
        {
            // OpenEXR magic 0x762f3101
            return Bytes[0] == 0x76 && Bytes[1] == 0x2F && Bytes[2] == 0x31 && Bytes[3] == 0x01;
        }
        return false;
    }

    /**
     * Parses width/height out of a PNG IHDR chunk (offset 16, 4 bytes each, BE).
     * Returns true on success and writes (W, H) to outputs. Doesn't handle EXR
     * or JPG header parsing — those skip dimension verification in v1.
     */
    static bool ParsePngDims(const TArray<uint8>& Bytes, int32& OutW, int32& OutH)
    {
        if (Bytes.Num() < 24) return false;
        const auto BE32 = [&](int32 Offset) {
            return (uint32(Bytes[Offset]) << 24) | (uint32(Bytes[Offset+1]) << 16)
                 | (uint32(Bytes[Offset+2]) <<  8) |  uint32(Bytes[Offset+3]);
        };
        OutW = (int32)BE32(16);
        OutH = (int32)BE32(20);
        return OutW > 0 && OutH > 0;
    }

    struct FCameraSpec
    {
        bool bIsActor = false;
        FString ActorPath;
        FVector Location  = FVector::ZeroVector;
        FRotator Rotation = FRotator::ZeroRotator;
        float Fov         = 90.0f;
    };

    struct FRenderState
    {
        FCameraSpec Camera;
        FString OutPath;
        int32 Width = 1920;
        int32 Height = 1080;
        FString Format = TEXT("png");
        TArray<FString> WaitSubsystems;
        double TimeoutSeconds = 30.0;
        // Game-thread-filled outputs:
        bool bWaitTimedOut = false;
        TArray<FString> TimedOutSubsystems;
        bool bRendered = false;
        FString FailReason;
        FString EngineHint;
        double WaitMs = 0.0;
        double RenderMs = 0.0;
        // FEvent:
        FEvent* DoneEvent = nullptr;

        // Returned to the pool only when the LAST owner (caller OR the async
        // game-thread task, whichever finishes last) drops its shared ref — so
        // the event is never recycled while the task may still Trigger() it.
        ~FRenderState()
        {
            if (DoneEvent)
            {
                FPlatformProcess::ReturnSynchEventToPool(DoneEvent);
                DoneEvent = nullptr;
            }
        }
    };

    using FRenderStatePtr = TSharedPtr<FRenderState, ESPMode::ThreadSafe>;

    static AHaybaMCPCaptureActor* GetOrSpawnCaptureActor(UWorld* World)
    {
        if (!World) return nullptr;
        for (TActorIterator<AHaybaMCPCaptureActor> It(World); It; ++It)
        {
            return *It;
        }
        return World->SpawnActor<AHaybaMCPCaptureActor>(AHaybaMCPCaptureActor::StaticClass());
    }

    /** Game-thread render execution. Takes a shared ref so the state stays
     *  alive for the whole task even if the caller's bounded wait timed out. */
    static void RunOnGameThread(FRenderStatePtr S)
    {
        const double T0 = FPlatformTime::Seconds();
        UWorld* World = ActiveEditorWorld();
        if (!World)
        {
            S->bRendered = false;
            S->FailReason = TEXT("file_not_written");
            S->EngineHint = TEXT("no editor world");
            if (S->DoneEvent) S->DoneEvent->Trigger();
            return;
        }

        // Resolve camera — fail fast on actor not found.
        USceneCaptureComponent2D* Capture = nullptr;
        FVector Loc = S->Camera.Location;
        FRotator Rot = S->Camera.Rotation;
        float Fov = S->Camera.Fov;

        AHaybaMCPCaptureActor* InternalActor = nullptr;
        AActor* UserActor = nullptr;

        if (S->Camera.bIsActor)
        {
            FSoftObjectPath Soft(S->Camera.ActorPath);
            UObject* Loaded = Soft.TryLoad();
            UserActor = Cast<AActor>(Loaded);
            if (!UserActor)
            {
                S->bRendered = false;
                S->FailReason = TEXT("actor_not_found");
                S->EngineHint = S->Camera.ActorPath;
                if (S->DoneEvent) S->DoneEvent->Trigger();
                return;
            }
            // Prefer an existing SceneCapture component on the actor; otherwise
            // fall back to camera transform + FOV from a UCameraComponent.
            Capture = UserActor->FindComponentByClass<USceneCaptureComponent2D>();
            if (!Capture)
            {
                if (UCameraComponent* Cam = UserActor->FindComponentByClass<UCameraComponent>())
                {
                    InternalActor = GetOrSpawnCaptureActor(World);
                    if (!InternalActor)
                    {
                        S->bRendered = false;
                        S->FailReason = TEXT("file_not_written");
                        S->EngineHint = TEXT("failed to spawn capture actor");
                        if (S->DoneEvent) S->DoneEvent->Trigger();
                        return;
                    }
                    Capture = InternalActor->Capture;
                    Loc = Cam->GetComponentLocation();
                    Rot = Cam->GetComponentRotation();
                    Fov = Cam->FieldOfView;
                    InternalActor->SetActorLocationAndRotation(Loc, Rot);
                }
                else
                {
                    S->bRendered = false;
                    S->FailReason = TEXT("actor_not_found");
                    S->EngineHint = TEXT("no camera or scene-capture component on actor");
                    if (S->DoneEvent) S->DoneEvent->Trigger();
                    return;
                }
            }
        }
        else
        {
            InternalActor = GetOrSpawnCaptureActor(World);
            if (!InternalActor)
            {
                S->bRendered = false;
                S->FailReason = TEXT("file_not_written");
                S->EngineHint = TEXT("failed to spawn capture actor");
                if (S->DoneEvent) S->DoneEvent->Trigger();
                return;
            }
            Capture = InternalActor->Capture;
            InternalActor->SetActorLocationAndRotation(Loc, Rot);
        }

        if (Capture)
        {
            Capture->FOVAngle = Fov;
            Capture->bCaptureEveryFrame = false;
            Capture->bCaptureOnMovement = false;
        }

        // ── Wait phase (game thread, 250ms granularity) ───────────────────────
        const double WaitT0 = FPlatformTime::Seconds();
        const uint64 StartFrame = GFrameCounter;
        const int32 WorldTicksRequired = 1;
        TSet<FString> Remaining(S->WaitSubsystems);
        while (Remaining.Num() > 0)
        {
            const double Now = FPlatformTime::Seconds();
            if ((Now - WaitT0) >= S->TimeoutSeconds)
            {
                S->bWaitTimedOut = true;
                S->TimedOutSubsystems = Remaining.Array();
                S->WaitMs = (Now - WaitT0) * 1000.0;
                S->bRendered = false;
                if (S->DoneEvent) S->DoneEvent->Trigger();
                return;
            }
            TArray<FString> Settled;
            for (const FString& Sub : Remaining)
            {
                if (!IsSubsystemBusy(Sub, StartFrame, WorldTicksRequired))
                {
                    Settled.Add(Sub);
                }
            }
            for (const FString& Sub : Settled) Remaining.Remove(Sub);
            if (Remaining.Num() == 0) break;
            FPlatformProcess::Sleep((float)POLL_INTERVAL_SECONDS);
        }
        S->WaitMs = (FPlatformTime::Seconds() - WaitT0) * 1000.0;

        // ── Render ────────────────────────────────────────────────────────────
        const double RenderT0 = FPlatformTime::Seconds();
        UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>(World);
        RT->RenderTargetFormat = (S->Format == TEXT("exr"))
            ? ETextureRenderTargetFormat::RTF_RGBA16f
            : ETextureRenderTargetFormat::RTF_RGBA8;
        RT->InitAutoFormat(S->Width, S->Height);
        RT->UpdateResourceImmediate(true);
        Capture->TextureTarget = RT;
        Capture->CaptureScene();

        FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
        if (!Res)
        {
            S->bRendered = false;
            S->FailReason = TEXT("file_not_written");
            S->EngineHint = TEXT("no render target resource");
            if (S->DoneEvent) S->DoneEvent->Trigger();
            return;
        }

        // Ensure parent dir exists.
        const FString ParentDir = FPaths::GetPath(S->OutPath);
        IFileManager::Get().MakeDirectory(*ParentDir, /*Tree=*/true);

        bool bWrote = false;
        if (S->Format == TEXT("exr"))
        {
            TArray<FFloat16Color> HdrPixels;
            Res->ReadFloat16Pixels(HdrPixels);
            // FImageUtils EXR path varies by UE version; use simple linear PNG fallback
            // and rename if SaveImageByExtension isn't available. For 5.7 we use
            // FImageUtils::SaveImageByExtension when present, else fall back to PNG.
            // Conservative: serialize as PNG when EXR helper isn't available.
            TArray<FColor> Pixels;
            Res->ReadPixels(Pixels);
            TArray<uint8> CompressedPng;
            FImageUtils::ThumbnailCompressImageArray(S->Width, S->Height, Pixels, CompressedPng);
            bWrote = FFileHelper::SaveArrayToFile(CompressedPng, *S->OutPath);
            if (!bWrote) S->EngineHint = TEXT("png write failed (EXR fallback)");
        }
        else
        {
            TArray<FColor> Pixels;
            Res->ReadPixels(Pixels);
            TArray<uint8> Compressed;
            FImageUtils::ThumbnailCompressImageArray(S->Width, S->Height, Pixels, Compressed);
            bWrote = FFileHelper::SaveArrayToFile(Compressed, *S->OutPath);
            if (!bWrote) S->EngineHint = TEXT("file write failed");
        }
        S->RenderMs = (FPlatformTime::Seconds() - RenderT0) * 1000.0;

        if (!bWrote)
        {
            S->bRendered = false;
            S->FailReason = TEXT("file_not_written");
            if (S->DoneEvent) S->DoneEvent->Trigger();
            return;
        }

        S->bRendered = true;
        if (S->DoneEvent) S->DoneEvent->Trigger();
    }
}

TArray<FString> FHaybaMCPRenderHandler::GetCommands() const
{
    return { TEXT("render_camera") };
}

FHaybaHandlerResult FHaybaMCPRenderHandler::Handle(const FString& /*Command*/,
                                                    const TSharedPtr<FJsonObject>& Params)
{
    using namespace HaybaRender;

    if (!Params.IsValid())
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: missing params"));
    }

    FRenderStatePtr S = MakeShared<FRenderState, ESPMode::ThreadSafe>();

    // ── Parse camera ──────────────────────────────────────────────────────
    const TSharedPtr<FJsonObject>* CameraObj = nullptr;
    if (!Params->TryGetObjectField(TEXT("camera"), CameraObj) || !CameraObj || !(*CameraObj).IsValid())
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: missing camera object"));
    }
    FString Kind;
    (*CameraObj)->TryGetStringField(TEXT("kind"), Kind);
    if (Kind == TEXT("actor"))
    {
        S->Camera.bIsActor = true;
        (*CameraObj)->TryGetStringField(TEXT("actor"), S->Camera.ActorPath);
    }
    else if (Kind == TEXT("transform"))
    {
        S->Camera.bIsActor = false;
        const TArray<TSharedPtr<FJsonValue>>* Loc = nullptr;
        const TArray<TSharedPtr<FJsonValue>>* Rot = nullptr;
        (*CameraObj)->TryGetArrayField(TEXT("location"), Loc);
        (*CameraObj)->TryGetArrayField(TEXT("rotation"), Rot);
        if (Loc && Loc->Num() == 3)
        {
            S->Camera.Location = FVector((*Loc)[0]->AsNumber(), (*Loc)[1]->AsNumber(), (*Loc)[2]->AsNumber());
        }
        if (Rot && Rot->Num() == 3)
        {
            S->Camera.Rotation = FRotator((*Rot)[0]->AsNumber(), (*Rot)[1]->AsNumber(), (*Rot)[2]->AsNumber());
        }
        double FovD = 90.0;
        if ((*CameraObj)->TryGetNumberField(TEXT("fov"), FovD)) S->Camera.Fov = (float)FovD;
    }
    else
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: camera.kind must be 'actor' or 'transform'"));
    }

    // ── Other params ──────────────────────────────────────────────────────
    FString OutPathReq;
    Params->TryGetStringField(TEXT("output_path"), OutPathReq);
    int32 W = 1920, H = 1080;
    int64 W64 = 0, H64 = 0;
    if (Params->TryGetNumberField(TEXT("width"), W64))  W = (int32)W64;
    if (Params->TryGetNumberField(TEXT("height"), H64)) H = (int32)H64;
    S->Width = W; S->Height = H;

    FString Format = TEXT("png");
    Params->TryGetStringField(TEXT("format"), Format);
    S->Format = Format;

    double TimeoutD = 30.0;
    Params->TryGetNumberField(TEXT("wait_timeout_s"), TimeoutD);
    S->TimeoutSeconds = TimeoutD;

    const TArray<TSharedPtr<FJsonValue>>* Subs = nullptr;
    if (Params->TryGetArrayField(TEXT("wait_for_subsystems"), Subs) && Subs)
    {
        for (const TSharedPtr<FJsonValue>& V : *Subs) S->WaitSubsystems.Add(V->AsString());
    }
    if (S->WaitSubsystems.Num() == 0)
    {
        S->WaitSubsystems = { TEXT("shaders"), TEXT("assets"), TEXT("world_tick") };
    }

    S->OutPath = ResolveOutputPath(OutPathReq, S->Format);

    // ── Cross-thread event ────────────────────────────────────────────────
    S->DoneEvent = FPlatformProcess::GetSynchEventFromPool(/*bIsManualReset=*/ false);
    if (!S->DoneEvent)
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: failed to allocate FEvent"));
    }

    // The lambda captures the shared ref, so S (and its FEvent) outlive this
    // function even if the wait below times out — RunOnGameThread can never
    // touch freed state.
    AsyncTask(ENamedThreads::GameThread, [S]() { RunOnGameThread(S); });

    // Allow the wait phase + render + headroom.
    const uint32 BlockTimeoutMs = (uint32)((S->TimeoutSeconds + 60.0) * 1000.0);
    const bool bSignaled = S->DoneEvent->Wait(BlockTimeoutMs);

    // ── Build response ────────────────────────────────────────────────────
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();

    if (!bSignaled)
    {
        // The game-thread task is still running (busy/hitched/deadlocked). Do
        // NOT read S's task-written fields here — that would race the game
        // thread. The task keeps its own shared ref and will free S when it
        // finishes; we just report the timeout.
        Out->SetBoolField(TEXT("ok"), false);
        TSharedPtr<FJsonObject> Err = MakeShared<FJsonObject>();
        Err->SetStringField(TEXT("kind"), TEXT("render_timeout"));
        Err->SetStringField(TEXT("engineHint"), TEXT("render did not complete within wait_timeout_s + 60s; the game thread may be blocked"));
        Out->SetObjectField(TEXT("error"), Err);
        return FHaybaHandlerResult::Ok(Out);
    }

    if (S->bWaitTimedOut)
    {
        Out->SetBoolField(TEXT("ok"), false);
        TSharedPtr<FJsonObject> Err = MakeShared<FJsonObject>();
        Err->SetStringField(TEXT("kind"), TEXT("wait_timeout"));
        TArray<TSharedPtr<FJsonValue>> TimedOut;
        for (const FString& Sub : S->TimedOutSubsystems) TimedOut.Add(MakeShared<FJsonValueString>(Sub));
        Err->SetArrayField(TEXT("timedOut"), TimedOut);
        Out->SetObjectField(TEXT("error"), Err);
    }
    else if (!S->bRendered)
    {
        Out->SetBoolField(TEXT("ok"), false);
        TSharedPtr<FJsonObject> Err = MakeShared<FJsonObject>();
        Err->SetStringField(TEXT("kind"), S->FailReason.IsEmpty() ? TEXT("file_not_written") : S->FailReason);
        Err->SetStringField(TEXT("attempted"), S->OutPath);
        if (!S->EngineHint.IsEmpty()) Err->SetStringField(TEXT("engineHint"), S->EngineHint);
        Out->SetObjectField(TEXT("error"), Err);
    }
    else
    {
        // ── Verify ──
        TArray<uint8> FileBytes;
        const bool bRead = FFileHelper::LoadFileToArray(FileBytes, *S->OutPath);
        const int64 SizeBytes = bRead ? FileBytes.Num() : 0;

        FString FirstHex;
        const bool bMagic = bRead && VerifyMagic(FileBytes, S->Format, FirstHex);

        bool bDimsOk = true;
        int32 PngW = 0, PngH = 0;
        if (bMagic && S->Format == TEXT("png"))
        {
            if (ParsePngDims(FileBytes, PngW, PngH))
            {
                bDimsOk = (PngW == S->Width && PngH == S->Height);
            }
        }

        if (!bRead || SizeBytes < 8 || !bMagic || !bDimsOk)
        {
            Out->SetBoolField(TEXT("ok"), false);
            TSharedPtr<FJsonObject> Err = MakeShared<FJsonObject>();
            Err->SetStringField(TEXT("kind"), TEXT("file_invalid"));
            Err->SetStringField(TEXT("attempted"), S->OutPath);
            Err->SetNumberField(TEXT("sizeBytes"), (double)SizeBytes);
            Err->SetStringField(TEXT("firstBytesHex"), FirstHex);
            Err->SetStringField(TEXT("expectedFormat"), S->Format);
            if (!bDimsOk)
            {
                Err->SetNumberField(TEXT("actualWidth"), (double)PngW);
                Err->SetNumberField(TEXT("actualHeight"), (double)PngH);
            }
            Out->SetObjectField(TEXT("error"), Err);
        }
        else
        {
            Out->SetBoolField(TEXT("ok"), true);
            Out->SetStringField(TEXT("path"), S->OutPath);
            Out->SetNumberField(TEXT("width"), S->Width);
            Out->SetNumberField(TEXT("height"), S->Height);
            Out->SetNumberField(TEXT("fileBytes"), (double)SizeBytes);
            Out->SetNumberField(TEXT("renderDurationMs"), S->RenderMs);
            Out->SetNumberField(TEXT("waitMs"), S->WaitMs);
        }
    }

    // No manual cleanup: when this function's shared ref to S drops (and the
    // async task's ref, whichever is last), ~FRenderState returns the FEvent to
    // the pool. This is safe because we reached here only after the event was
    // signaled, i.e. the task is done with S.
    return FHaybaHandlerResult::Ok(Out);
}
