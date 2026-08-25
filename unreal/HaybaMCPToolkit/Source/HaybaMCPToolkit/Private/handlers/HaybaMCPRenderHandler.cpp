// HaybaMCPRenderHandler.cpp — see header.
//
// Threading: ProcessCommand drains requests on the game thread. Handle()
// enforces that boundary before acquiring a render lease or touching any
// UWorld/SceneCapture/RHI state. Off-thread callers are rejected without
// queuing module-owned work, so shutdown can never unload beneath a late task.

#include "HaybaMCPRenderHandler.h"
#include "HaybaMCPCaptureActor.h"
#include "HaybaMCPRenderSafety.h"

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
#include "Misc/ScopeExit.h"
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
        // LoadModuleChecked turns a missing/unloading optional subsystem into a
        // process-fatal check. A render preflight must degrade safely instead.
        FAssetRegistryModule* Mod = FModuleManager::Get().LoadModulePtr<FAssetRegistryModule>(TEXT("AssetRegistry"));
        return Mod && Mod->Get().IsLoadingAssets();
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
        int64 FileBytes = 0;
        // True when world_tick was dropped from the wait set because Handle()
        // ran inline on the game thread (see RunOnGameThread wait phase).
        bool bSkippedWorldTickInline = false;
        TSharedPtr<HaybaRenderSafety::FLease, ESPMode::ThreadSafe> Lease;
    };

    using FRenderStatePtr = TSharedPtr<FRenderState, ESPMode::ThreadSafe>;

    static AHaybaMCPCaptureActor* GetOrSpawnCaptureActor(UWorld* World)
    {
        if (!World) return nullptr;
        for (TActorIterator<AHaybaMCPCaptureActor> It(World); It; ++It)
        {
            if (IsValid(*It) && !It->IsActorBeingDestroyed()) return *It;
        }
        return World->SpawnActor<AHaybaMCPCaptureActor>(AHaybaMCPCaptureActor::StaticClass());
    }

    /** Synchronous game-thread render execution. The shared state keeps the
     *  lease and cleanup data together for the duration of this call. */
    static void RunOnGameThread(FRenderStatePtr S)
    {
        auto Fail = [&S](const FString& Kind, const FString& Hint)
        {
            S->bRendered = false;
            S->FailReason = Kind;
            S->EngineHint = Hint;
        };

        if (!IsInGameThread())
        {
            Fail(TEXT("render_lifecycle"), TEXT("render task was not executing on the game thread"));
            return;
        }
        FString LifecycleError;
        if (!S->Lease.IsValid() || !S->Lease->Advance(HaybaRenderSafety::EStage::WaitingForIdle, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        UWorld* World = ActiveEditorWorld();
        if (!IsValid(World) || World->bIsTearingDown)
        {
            Fail(TEXT("render_lifecycle"), TEXT("no stable editor world (missing or tearing down)"));
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
            // Camera actors must already belong to the active world. TryLoad()
            // could synchronously load arbitrary caller-named content while a
            // render lease is held, broadening both crash and deadline scope.
            UObject* Loaded = Soft.ResolveObject();
            UserActor = Cast<AActor>(Loaded);
            if (!IsValid(UserActor) || UserActor->IsActorBeingDestroyed() || UserActor->GetWorld() != World)
            {
                S->bRendered = false;
                S->FailReason = TEXT("actor_not_found");
                S->EngineHint = S->Camera.ActorPath + TEXT(" (actor must already exist in the active editor world)");
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
                        Fail(TEXT("render_lifecycle"), TEXT("failed to spawn capture actor"));
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
                    return;
                }
            }
        }
        else
        {
            InternalActor = GetOrSpawnCaptureActor(World);
            if (!InternalActor)
            {
                Fail(TEXT("render_lifecycle"), TEXT("failed to spawn capture actor"));
                return;
            }
            Capture = InternalActor->Capture;
            InternalActor->SetActorLocationAndRotation(Loc, Rot);
        }

        if (!IsValid(Capture))
        {
            Fail(TEXT("render_lifecycle"), TEXT("camera has no valid scene-capture component"));
            return;
        }

        const float PreviousFov = Capture->FOVAngle;
        const bool bPreviousEveryFrame = Capture->bCaptureEveryFrame;
        const bool bPreviousOnMovement = Capture->bCaptureOnMovement;
        UTextureRenderTarget2D* PreviousTarget = Capture->TextureTarget;
        UTextureRenderTarget2D* OperationTarget = nullptr;
        ON_SCOPE_EXIT
        {
            if (IsValid(Capture))
            {
                Capture->TextureTarget = PreviousTarget;
                Capture->FOVAngle = PreviousFov;
                Capture->bCaptureEveryFrame = bPreviousEveryFrame;
                Capture->bCaptureOnMovement = bPreviousOnMovement;
            }
            if (IsValid(OperationTarget))
            {
                OperationTarget->ReleaseResource();
                FlushRenderingCommands();
            }
        };
        Capture->FOVAngle = Fov;
        Capture->bCaptureEveryFrame = false;
        Capture->bCaptureOnMovement = false;

        // ── Wait phase (game thread, 250ms granularity) ───────────────────────
        const double WaitT0 = FPlatformTime::Seconds();
        const uint64 StartFrame = GFrameCounter;
        const int32 WorldTicksRequired = 1;
        TSet<FString> Remaining(S->WaitSubsystems);
        // RunOnGameThread always executes inline on the game thread. While this
        // call Sleeps below, the game thread is occupied and
        // GFrameCounter cannot advance, so world_tick's predicate
        // ((GFrameCounter - StartFrame) < 1) can never settle from here: it
        // would spin to the full timeout and write no image. Drop it from the
        // wait set; shaders/assets still settle because their work progresses
        // on other threads. The IsInGameThread() guard documents the intent and
        // keeps this correct if RunOnGameThread is ever dispatched off-thread.
        if (IsInGameThread() && Remaining.Remove(TEXT("world_tick")) > 0)
        {
            S->bSkippedWorldTickInline = true;
        }
        while (Remaining.Num() > 0)
        {
            if (!S->Lease->Advance(HaybaRenderSafety::EStage::WaitingForIdle, LifecycleError))
            {
                Fail(TEXT("render_lifecycle"), LifecycleError);
                return;
            }
            const double Now = FPlatformTime::Seconds();
            if ((Now - WaitT0) >= S->TimeoutSeconds)
            {
                S->bWaitTimedOut = true;
                S->TimedOutSubsystems = Remaining.Array();
                S->WaitMs = (Now - WaitT0) * 1000.0;
                S->bRendered = false;
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

        if (!S->Lease->Advance(HaybaRenderSafety::EStage::AllocatingTarget, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }

        // ── Render ────────────────────────────────────────────────────────────
        const double RenderT0 = FPlatformTime::Seconds();
        UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>(World);
        if (!RT)
        {
            Fail(TEXT("render_lifecycle"), TEXT("render-target allocation returned null"));
            return;
        }
        OperationTarget = RT;
        RT->RenderTargetFormat = ETextureRenderTargetFormat::RTF_RGBA8;
        RT->InitAutoFormat(S->Width, S->Height);
        RT->UpdateResourceImmediate(true);
        Capture->TextureTarget = RT;

        if (!S->Lease->Advance(HaybaRenderSafety::EStage::Capturing, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        Capture->CaptureScene();

        FTextureRenderTargetResource* Res = RT->GameThread_GetRenderTargetResource();
        if (!Res)
        {
            Fail(TEXT("render_lifecycle"), TEXT("render target has no game-thread resource"));
            return;
        }

        if (!S->Lease->Advance(HaybaRenderSafety::EStage::ReadingBack, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        TArray<FColor> Pixels;
        if (!Res->ReadPixels(Pixels) || Pixels.Num() != int64(S->Width) * int64(S->Height))
        {
            Fail(TEXT("render_readback"), FString::Printf(TEXT("pixel readback returned %d pixels, expected %lld"),
                Pixels.Num(), int64(S->Width) * int64(S->Height)));
            return;
        }

        if (!S->Lease->Advance(HaybaRenderSafety::EStage::Encoding, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        TArray64<uint8> Encoded;
        if (S->Format == TEXT("jpg"))
        {
            TArray<uint8> Narrow;
            FImageUtils::ThumbnailCompressImageArray(S->Width, S->Height, Pixels, Narrow);
            Encoded.Append(Narrow.GetData(), Narrow.Num());
        }
        else
        {
            FImageUtils::PNGCompressImageArray(S->Width, S->Height, Pixels, Encoded);
        }

        if (!S->Lease->Advance(HaybaRenderSafety::EStage::Publishing, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        FString PublishError;
        if (!HaybaRenderSafety::PublishVerifiedImage(
            Encoded, S->Format, S->Width, S->Height, S->OutPath, S->FileBytes, PublishError))
        {
            Fail(TEXT("file_invalid"), PublishError);
            return;
        }
        if (!S->Lease->Advance(HaybaRenderSafety::EStage::Complete, LifecycleError))
        {
            Fail(TEXT("render_lifecycle"), LifecycleError);
            return;
        }
        S->RenderMs = (FPlatformTime::Seconds() - RenderT0) * 1000.0;

        S->bRendered = true;
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
        if (S->Camera.ActorPath.IsEmpty() || S->Camera.ActorPath.Len() > 1024)
        {
            return FHaybaHandlerResult::Err(TEXT("render_camera: camera.actor must be a non-empty object path under 1024 characters"));
        }
    }
    else if (Kind == TEXT("transform"))
    {
        S->Camera.bIsActor = false;
        const TArray<TSharedPtr<FJsonValue>>* Loc = nullptr;
        const TArray<TSharedPtr<FJsonValue>>* Rot = nullptr;
        (*CameraObj)->TryGetArrayField(TEXT("location"), Loc);
        (*CameraObj)->TryGetArrayField(TEXT("rotation"), Rot);

        // A present-but-malformed array used to fall through the `Num() == 3`
        // check and leave the default in place, so a two-element location
        // rendered from the origin and reported success. The picture comes back,
        // it is simply of the wrong place — which is the hardest kind of wrong
        // to notice in an automated pipeline.
        if (Loc && Loc->Num() != 3)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("render_camera: camera.location needs 3 numbers, got %d"), Loc->Num()));
        }
        if (Rot && Rot->Num() != 3)
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("render_camera: camera.rotation needs 3 numbers, got %d"), Rot->Num()));
        }

        if (Loc)
        {
            for (const TSharedPtr<FJsonValue>& Value : *Loc)
            {
                if (!Value.IsValid() || Value->Type != EJson::Number || !FMath::IsFinite(Value->AsNumber()))
                    return FHaybaHandlerResult::Err(TEXT("render_camera: camera.location must contain 3 finite numbers"));
            }
            S->Camera.Location = FVector((*Loc)[0]->AsNumber(), (*Loc)[1]->AsNumber(), (*Loc)[2]->AsNumber());
        }
        if (Rot)
        {
            // NOTE — deliberately different from editor_set_camera, which reads
            // an array rotation as [pitch, yaw] and IGNORES a third element so a
            // stray value cannot tilt the horizon (HaybaEditorOps.h).
            //
            // Here the third element IS applied as roll, because a rendered shot
            // is a camera setup where a deliberate dutch angle is legitimate,
            // whereas the editor viewport is a place you have to keep working in.
            // Two commands that look like the same operation and are not; stated
            // here so the next person does not "fix" one to match the other by
            // accident. See #320.
            for (const TSharedPtr<FJsonValue>& Value : *Rot)
            {
                if (!Value.IsValid() || Value->Type != EJson::Number || !FMath::IsFinite(Value->AsNumber()))
                    return FHaybaHandlerResult::Err(TEXT("render_camera: camera.rotation must contain 3 finite numbers"));
            }
            S->Camera.Rotation = FRotator((*Rot)[0]->AsNumber(), (*Rot)[1]->AsNumber(), (*Rot)[2]->AsNumber());
        }
        double FovD = 90.0;
        if ((*CameraObj)->TryGetNumberField(TEXT("fov"), FovD))
        {
            if (!FMath::IsFinite(FovD) || FovD < 5.0 || FovD > 170.0)
                return FHaybaHandlerResult::Err(TEXT("render_camera: camera.fov must be finite and in [5,170] degrees"));
            S->Camera.Fov = (float)FovD;
        }
    }
    else
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: camera.kind must be 'actor' or 'transform'"));
    }

    // ── Other params ──────────────────────────────────────────────────────
    FString OutPathReq;
    Params->TryGetStringField(TEXT("output_path"), OutPathReq);
    double RequestedWidth = 1920.0;
    double RequestedHeight = 1080.0;
    Params->TryGetNumberField(TEXT("width"), RequestedWidth);
    Params->TryGetNumberField(TEXT("height"), RequestedHeight);
    FString ValidationError;
    if (!HaybaRenderSafety::ValidateDimensions(
        RequestedWidth, RequestedHeight, S->Width, S->Height, ValidationError))
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: ") + ValidationError);
    }

    FString Format = TEXT("png");
    Params->TryGetStringField(TEXT("format"), Format);
    Format.ToLowerInline();
    S->Format = Format;

    double TimeoutD = 30.0;
    Params->TryGetNumberField(TEXT("wait_timeout_s"), TimeoutD);
    if (!FMath::IsFinite(TimeoutD) || TimeoutD < 0.0 || TimeoutD > 60.0)
        return FHaybaHandlerResult::Err(TEXT("render_camera: wait_timeout_s must be finite and in [0,60]"));
    S->TimeoutSeconds = TimeoutD;

    const TArray<TSharedPtr<FJsonValue>>* Subs = nullptr;
    if (Params->TryGetArrayField(TEXT("wait_for_subsystems"), Subs) && Subs)
    {
        if (Subs->Num() > 5)
            return FHaybaHandlerResult::Err(TEXT("render_camera: wait_for_subsystems accepts at most 5 entries"));
        static const TSet<FString> Allowed = {
            TEXT("shaders"), TEXT("assets"), TEXT("gc"), TEXT("pcg"), TEXT("world_tick")
        };
        for (const TSharedPtr<FJsonValue>& V : *Subs)
        {
            if (!V.IsValid() || V->Type != EJson::String || !Allowed.Contains(V->AsString()))
                return FHaybaHandlerResult::Err(TEXT("render_camera: wait_for_subsystems entries must be shaders, assets, gc, pcg, or world_tick"));
            S->WaitSubsystems.AddUnique(V->AsString());
        }
    }
    if (S->WaitSubsystems.Num() == 0)
    {
        S->WaitSubsystems = { TEXT("shaders"), TEXT("assets"), TEXT("world_tick") };
    }

    if (!HaybaRenderSafety::ResolveOutputPath(
        OutPathReq, S->Format, TEXT("hayba_camera"), S->OutPath, ValidationError))
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: ") + ValidationError);
    }

    // wait_timeout_s is the idle phase. Encoding/publishing receives another
    // bounded 15 seconds, with a hard policy ceiling of 75 seconds.
    S->Lease = HaybaRenderSafety::FLease::TryAcquire(
        TEXT("render_camera"), FMath::Max(15.0, TimeoutD + 15.0), ValidationError);
    if (!S->Lease.IsValid())
    {
        return FHaybaHandlerResult::Err(TEXT("render_camera: ") + ValidationError);
    }

    // ProcessCommand is a game-thread boundary. Do not recreate the former
    // off-thread marshal here: if its bounded wait elapsed, the queued lambda
    // still retained this module's code and render lease while module shutdown
    // continued. That is an unload-time UAF, not a recoverable timeout. A
    // future non-TCP caller must marshal the whole command before entering the
    // handler, where ownership and cancellation can be tracked centrally.
    if (!IsInGameThread())
    {
        return FHaybaHandlerResult::Err(
            TEXT("render_camera: must run on the game thread; no render work was queued"));
    }
    RunOnGameThread(S);

    // ── Build response ────────────────────────────────────────────────────
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();

    if (S->bWaitTimedOut)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("render_camera: idle wait timed out after %.0f ms (%s). Increase wait_timeout_s within the 60-second cap, or wait for those subsystems before retrying."),
            S->WaitMs, *FString::Join(S->TimedOutSubsystems, TEXT(", "))));
    }
    else if (!S->bRendered)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("render_camera: %s at lifecycle stage %s; attempted '%s'. %s"),
            S->FailReason.IsEmpty() ? TEXT("render failed") : *S->FailReason,
            S->Lease.IsValid() ? HaybaRenderSafety::StageName(S->Lease->GetStage()) : TEXT("unknown"),
            *S->OutPath, *S->EngineHint));
    }
    else
    {
        Out->SetBoolField(TEXT("ok"), true);
        Out->SetBoolField(TEXT("artifact_verified"), true);
        Out->SetStringField(TEXT("path"), S->OutPath);
        Out->SetStringField(TEXT("format"), S->Format);
        Out->SetNumberField(TEXT("width"), S->Width);
        Out->SetNumberField(TEXT("height"), S->Height);
        Out->SetNumberField(TEXT("fileBytes"), (double)S->FileBytes);
        Out->SetNumberField(TEXT("renderDurationMs"), S->RenderMs);
        Out->SetNumberField(TEXT("waitMs"), S->WaitMs);
        if (S->bSkippedWorldTickInline)
        {
            Out->SetBoolField(TEXT("skippedWorldTickInline"), true);
        }
    }

    // Render resources are released by the scope-exit guard inside
    // RunOnGameThread. Dropping S here releases only ordinary response/lease
    // state; no queued task or pooled event can outlive the handler.
    return FHaybaHandlerResult::Ok(Out);
}
