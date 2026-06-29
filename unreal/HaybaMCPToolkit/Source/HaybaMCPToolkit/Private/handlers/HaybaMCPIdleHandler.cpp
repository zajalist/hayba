// HaybaMCPIdleHandler.cpp — see header for the design summary.
//
// Threading: Handle() runs on the game thread (the TCP server drains its
// command queue from the engine tick), so it ensure(IsInGameThread()) and
// takes a single synchronous snapshot of the busy predicates (shaders,
// assets, gc, pcg, world_tick) — no waiting, no ticker, no FEvent. Touching
// these predicates is only safe on the game thread, which the synchronous
// snapshot guarantees. It deliberately does NOT block-and-wait: blocking the
// game thread can't let those subsystems make progress. Callers poll this in
// a loop; the editor ticks between calls, so `ok` flips true once idle.

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
            // TObjectIterator visits CDOs, archetypes, and objects mid-construct or
            // pending-kill. During PCG generation components churn fast, so a plain
            // null check is not enough — calling GetWorld()/IsGenerating() on a
            // garbage object derefs near-null (crash: reading 0x1). Guard hard.
            if (!IsValid(Comp)) continue;
            if (Comp->HasAnyFlags(RF_ClassDefaultObject | RF_ArchetypeObject)) continue;
            if (Comp->GetWorld() != World) continue;
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
            // Clamp: large timeout_s overflows the uint32 ms wait below (UB cast
            // -> near-zero wait, silent false timeout); negatives are nonsense.
            State.TimeoutSeconds = FMath::Clamp(State.TimeoutSeconds, 0.0, 3600.0);
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

    // ── Synchronous snapshot (no waiting) ─────────────────────────────────
    // Commands run on the game thread (TcpServer drains the queue from the
    // engine tick), so we read the busy predicates directly and return the
    // CURRENT settle state. We deliberately do NOT block-and-wait:
    //  * blocking the game thread can't let shaders/assets/GC progress anyway;
    //  * the old AsyncTask + FEvent::Wait + FTSTicker design dead-locked under
    //    this dispatch and use-after-freed (PollOnce ran on freed FWaitState).
    // Callers poll this in a loop — the editor ticks between calls, so
    // subsystems make progress and `ok` flips true once everything is idle.
    ensure(IsInGameThread());
    bool bAllSettled = true;
    for (const FString& Sub : State.Subsystems)
    {
        const bool bBusy = IsBusy(Sub, State);
        State.BusyOnEntry.Add(Sub, bBusy);
        if (bBusy)
        {
            bAllSettled = false;
        }
        else
        {
            State.SettledAtMs.Add(Sub, 0.0);
        }
    }
    State.bAllSettled = bAllSettled;
    State.FinalDurationMs = 0.0;

    return FHaybaHandlerResult::Ok(BuildResponse(State));
}
