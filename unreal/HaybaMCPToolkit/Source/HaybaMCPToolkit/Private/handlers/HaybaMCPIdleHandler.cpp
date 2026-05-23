// HaybaMCPIdleHandler.cpp — see header for the design summary.
//
// Threading: Handle() is invoked from the TCP server's per-request handler
// thread (NOT the game thread). We schedule a polling ticker on the core
// ticker (game-thread ticked) and block the calling thread on an FEvent
// until the ticker fires Done. Predicates like IsShadersBusy / IsGenerating
// must be touched on the game thread, so all polling happens there.

#include "HaybaMCPIdleHandler.h"

#include "Containers/Ticker.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "ShaderCompiler.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UObjectIterator.h"
#include "Engine/World.h"
#include "PCGComponent.h"

namespace HaybaIdle
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

    static bool IsGCBusyImpl()
    {
        return IsGarbageCollecting() || IsIncrementalPurgePending();
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

    static bool IsPCGBusyImpl(const TSet<FString>& ScopedActorPaths)
    {
        UWorld* World = ActiveEditorWorld();
        if (!World) return false;
        for (TObjectIterator<UPCGComponent> It; It; ++It)
        {
            UPCGComponent* Comp = *It;
            if (!Comp || Comp->GetWorld() != World) continue;
            AActor* Owner = Comp->GetOwner();
            if (!Owner) continue;
            if (ScopedActorPaths.Num() > 0)
            {
                const FString Path = Owner->GetPathName();
                if (!ScopedActorPaths.Contains(Path)) continue;
            }
            if (Comp->IsGenerating()) return true;
        }
        return false;
    }

    static bool IsWorldTickPendingImpl(int32 TicksRequired, uint64 StartFrameCounter)
    {
        return (GFrameCounter - StartFrameCounter) < (uint64)TicksRequired;
    }

    struct FWaitState
    {
        TSet<FString>            Subsystems;
        TSet<FString>            ScopedPcgActors;
        int32                    WorldTicksRequired = 1;
        uint64                   StartFrameCounter  = 0;
        double                   T0Seconds          = 0.0;
        double                   TimeoutSeconds     = 60.0;
        TMap<FString, bool>      BusyOnEntry;
        TMap<FString, double>    SettledAtMs;     // missing key = not settled
        FTSTicker::FDelegateHandle TickHandle;
        FEvent*                  DoneEvent        = nullptr;
        // Filled on the game thread, read on the TCP thread after DoneEvent fires.
        bool                     bAllSettled      = false;
        double                   FinalDurationMs  = 0.0;

        // The FEvent is pool-allocated and must be returned exactly once
        // when the last shared owner releases. Doing it here ties the
        // pool return to the state's lifetime so neither thread can
        // double-free or leak it.
        ~FWaitState()
        {
            if (DoneEvent)
            {
                FPlatformProcess::ReturnSynchEventToPool(DoneEvent);
                DoneEvent = nullptr;
            }
        }
    };

    static bool IsBusy(const FString& Sub, const FWaitState& S)
    {
        if (Sub == TEXT("shaders"))    return IsShadersBusyImpl();
        if (Sub == TEXT("assets"))     return IsAssetsBusyImpl();
        if (Sub == TEXT("gc"))         return IsGCBusyImpl();
        if (Sub == TEXT("pcg"))        return IsPCGBusyImpl(S.ScopedPcgActors);
        if (Sub == TEXT("world_tick")) return IsWorldTickPendingImpl(S.WorldTicksRequired, S.StartFrameCounter);
        return false;
    }

    static TSharedPtr<FJsonObject> BuildResponse(const FWaitState& S)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("ok"), S.bAllSettled);
        Out->SetNumberField(TEXT("durationMs"), S.FinalDurationMs);

        TSharedPtr<FJsonObject> Settled = MakeShared<FJsonObject>();
        for (const FString& Sub : S.Subsystems)
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetBoolField(TEXT("busyOnEntry"), S.BusyOnEntry.FindRef(Sub));
            const double* Ms = S.SettledAtMs.Find(Sub);
            Entry->SetNumberField(TEXT("settledAtMs"), Ms ? *Ms : S.FinalDurationMs);
            Settled->SetObjectField(Sub, Entry);
        }
        Out->SetObjectField(TEXT("settled"), Settled);

        if (!S.bAllSettled)
        {
            TArray<TSharedPtr<FJsonValue>> TimedOut;
            for (const FString& Sub : S.Subsystems)
            {
                if (!S.SettledAtMs.Contains(Sub))
                {
                    TimedOut.Add(MakeShared<FJsonValueString>(Sub));
                }
            }
            Out->SetArrayField(TEXT("timedOut"), TimedOut);
        }
        return Out;
    }

    /** Runs on the game thread via FTSTicker. Returns false to unregister. */
    static bool PollOnce(float /*Dt*/, FWaitState* S)
    {
        const double Now = FPlatformTime::Seconds();
        const double DurationMs = (Now - S->T0Seconds) * 1000.0;

        for (const FString& Sub : S->Subsystems)
        {
            if (S->SettledAtMs.Contains(Sub)) continue;
            if (!IsBusy(Sub, *S))
            {
                S->SettledAtMs.Add(Sub, DurationMs);
            }
        }

        const bool bAllSettled = (S->SettledAtMs.Num() == S->Subsystems.Num());
        const bool bTimedOut = (Now - S->T0Seconds) >= S->TimeoutSeconds;

        if (bAllSettled || bTimedOut)
        {
            S->bAllSettled = bAllSettled;
            S->FinalDurationMs = DurationMs;
            if (S->DoneEvent) S->DoneEvent->Trigger();
            return false;
        }
        return true;
    }
}

TArray<FString> FHaybaMCPIdleHandler::GetCommands() const
{
    return { TEXT("wait_for_idle"), TEXT("wait_for_shaders") };
}

FHaybaHandlerResult FHaybaMCPIdleHandler::Handle(const FString& Command,
                                                 const TSharedPtr<FJsonObject>& Params)
{
    using namespace HaybaIdle;

    FWaitState State;
    State.T0Seconds = FPlatformTime::Seconds();
    State.StartFrameCounter = GFrameCounter;

    // ── Parse params ──────────────────────────────────────────────────────
    if (Command == TEXT("wait_for_shaders"))
    {
        // Legacy command: subsystems implicit = shaders; max_seconds → timeout.
        State.Subsystems.Add(TEXT("shaders"));
        double Max = 60.0;
        if (Params.IsValid() && Params->HasField(TEXT("max_seconds")))
        {
            Max = Params->GetNumberField(TEXT("max_seconds"));
        }
        State.TimeoutSeconds = Max;
    }
    else
    {
        // wait_for_idle: subsystems[], timeout_s, pcg_actors?, world_ticks?
        if (Params.IsValid())
        {
            if (Params->HasField(TEXT("timeout_s")))
            {
                State.TimeoutSeconds = Params->GetNumberField(TEXT("timeout_s"));
            }
            const TArray<TSharedPtr<FJsonValue>>* SubsArr = nullptr;
            if (Params->TryGetArrayField(TEXT("subsystems"), SubsArr) && SubsArr)
            {
                for (const TSharedPtr<FJsonValue>& V : *SubsArr) State.Subsystems.Add(V->AsString());
            }
            const TArray<TSharedPtr<FJsonValue>>* ActorsArr = nullptr;
            if (Params->TryGetArrayField(TEXT("pcg_actors"), ActorsArr) && ActorsArr)
            {
                for (const TSharedPtr<FJsonValue>& V : *ActorsArr) State.ScopedPcgActors.Add(V->AsString());
            }
            if (Params->HasField(TEXT("world_ticks")))
            {
                State.WorldTicksRequired = (int32)Params->GetNumberField(TEXT("world_ticks"));
            }
        }
        if (State.Subsystems.Num() == 0)
        {
            State.Subsystems = { TEXT("shaders"), TEXT("assets"), TEXT("gc"), TEXT("pcg"), TEXT("world_tick") };
        }
    }

    // ── Cross-thread event ────────────────────────────────────────────────
    State.DoneEvent = FPlatformProcess::GetSynchEventFromPool(/*bIsManualReset=*/ false);
    if (!State.DoneEvent) return FHaybaHandlerResult::Err(TEXT("Failed to allocate FEvent"));

    // ── Schedule polling on the game thread ───────────────────────────────
    // Shared ownership: the TCP thread (this scope) holds one ref, the
    // game-thread ticker lambda holds another. Whichever releases last
    // destructs FWaitState, which returns DoneEvent to the pool. This
    // fixes a use-after-free where the TCP thread's FEvent wait could
    // expire while the ticker was still polling, freeing the state out
    // from under the next tick (crash: PollOnce reading freed Subsystems).
    TSharedRef<FWaitState, ESPMode::ThreadSafe> SharedState =
        MakeShared<FWaitState, ESPMode::ThreadSafe>(MoveTemp(State));

    AsyncTask(ENamedThreads::GameThread, [SharedState]()
    {
        // GC nudge — only when gc requested. Queue once, before the first poll,
        // so IsGCBusyImpl observes the pending pass briefly then sees it settle.
        if (SharedState->Subsystems.Contains(TEXT("gc")) && GEngine)
        {
            GEngine->ForceGarbageCollection(/*bFullPurge=*/ false);
        }
        // Capture busyOnEntry on the game thread (predicates are not thread-safe).
        for (const FString& Sub : SharedState->Subsystems)
        {
            SharedState->BusyOnEntry.Add(Sub, IsBusy(Sub, *SharedState));
        }
        SharedState->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateLambda([SharedState](float Dt) { return PollOnce(Dt, &SharedState.Get()); }),
            POLL_INTERVAL_SECONDS);
    });

    // ── Block this thread until polling completes or timeout fires ─────────
    // FEvent wait timeout is in milliseconds. Allow timeout_s + 1s slack so
    // the game-thread poller normally fires Done first.
    const uint32 WaitTimeoutMs = (uint32)(SharedState->TimeoutSeconds * 1000.0) + 1000;
    const bool bSignaled = SharedState->DoneEvent->Wait(WaitTimeoutMs);

    // Build response (read game-thread-filled state — safe because the event
    // signal serializes the write).
    TSharedPtr<FJsonObject> Resp;
    if (bSignaled)
    {
        Resp = BuildResponse(*SharedState);
    }
    else
    {
        // FEvent timed out before the game-thread poller. Stop the ticker
        // first so it cannot keep mutating SharedState while we read it;
        // RemoveTicker is safe from any thread but does not wait on an
        // in-flight tick — the shared ownership above is what makes that
        // safe (no use-after-free regardless of in-flight ticks).
        if (SharedState->TickHandle.IsValid())
        {
            FTSTicker::GetCoreTicker().RemoveTicker(SharedState->TickHandle);
            SharedState->TickHandle.Reset();
        }
        SharedState->FinalDurationMs = (FPlatformTime::Seconds() - SharedState->T0Seconds) * 1000.0;
        SharedState->bAllSettled = false;
        Resp = BuildResponse(*SharedState);
    }

    // No manual cleanup: when this scope's SharedState ref drops and the
    // game-thread ticker drops its lambda ref (whichever happens last),
    // FWaitState's destructor returns DoneEvent to the pool.

    return FHaybaHandlerResult::Ok(Resp);
}
