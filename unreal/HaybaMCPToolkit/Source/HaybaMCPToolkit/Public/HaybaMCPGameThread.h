#pragma once

#include "CoreMinimal.h"
#include "Async/Async.h"
#include "HAL/Event.h"
#include "HAL/PlatformProcess.h"

// ── Game-thread marshal seam ─────────────────────────────────────────────────
//
// Every MCP command already runs ON the game thread: HaybaMCPTcpServer wraps the
// whole command in AsyncTask(ENamedThreads::GameThread, ...) before any handler
// Handle() executes. So the overwhelmingly common case here is "I'm already on
// the game thread."
//
// The bug this seam exists to kill: a handler that, believing it runs off the
// game thread, does AsyncTask(GameThread, ...) and then BLOCKS on the result
// (FEvent->Wait / poll loop). Because it's already on the game thread, the queued
// task can never run until the handler returns -> deadlock until the bounded wait
// times out, and a use-after-free if the handler then frees state the still-
// pending task captured by raw pointer/reference. (Confirmed in render_camera,
// CaptureBeforeState, wait_for_idle.)
//
// Funnel all "run this on the game thread and give me the result" needs through
// HaybaGameThread::Run* so the inline-vs-marshal decision lives in ONE place and
// is always correct. When already on the game thread the work runs INLINE (no
// task, no event, no deadlock). Off the game thread it marshals via AsyncTask and
// blocks the caller up to TimeoutSeconds, with shared-state lifetime safety so a
// timed-out wait can never use-after-free.
namespace HaybaGameThread
{
    /**
     * Run Work on the game thread and return its result.
     * @param Work          the work to run (must return ResultType).
     * @param TimeoutSeconds bound on the marshal-and-wait path (ignored when inline).
     * @param TimeoutValue  returned only if the off-thread wait times out.
     */
    template <typename ResultType>
    ResultType RunSync(TFunction<ResultType()> Work, double TimeoutSeconds, ResultType TimeoutValue)
    {
        if (IsInGameThread())
        {
            return Work();
        }

        // Shared state so the marshaled lambda and the waiting caller both keep it
        // alive across the thread hop — by-reference capture would be a UAF risk
        // if the wait times out and the caller frame unwinds. On timeout we
        // deliberately do NOT return the FEvent to the pool: if the lambda runs
        // after we've given up it would trigger a recycled event and clobber an
        // unrelated waiter. Leaking one event per (rare) timeout is the lesser evil.
        struct FState
        {
            ResultType Result{};
            FEvent* Done = nullptr;
        };
        TSharedRef<FState, ESPMode::ThreadSafe> State = MakeShared<FState, ESPMode::ThreadSafe>();
        State->Done = FPlatformProcess::GetSynchEventFromPool(/*bIsManualReset=*/true);

        AsyncTask(ENamedThreads::GameThread, [Work = MoveTemp(Work), State]()
        {
            State->Result = Work();
            if (State->Done) State->Done->Trigger();
        });

        const bool bSignalled = State->Done->Wait(FTimespan::FromSeconds(TimeoutSeconds));
        if (bSignalled)
        {
            FPlatformProcess::ReturnSynchEventToPool(State->Done);
            State->Done = nullptr;
            return State->Result;
        }
        return TimeoutValue;
    }

    /** Void variant: run Work on the game thread (inline if already there). */
    inline void RunSyncVoid(TFunction<void()> Work, double TimeoutSeconds = 30.0)
    {
        if (IsInGameThread())
        {
            Work();
            return;
        }

        struct FState { FEvent* Done = nullptr; };
        TSharedRef<FState, ESPMode::ThreadSafe> State = MakeShared<FState, ESPMode::ThreadSafe>();
        State->Done = FPlatformProcess::GetSynchEventFromPool(/*bIsManualReset=*/true);

        AsyncTask(ENamedThreads::GameThread, [Work = MoveTemp(Work), State]()
        {
            Work();
            if (State->Done) State->Done->Trigger();
        });

        const bool bSignalled = State->Done->Wait(FTimespan::FromSeconds(TimeoutSeconds));
        if (bSignalled)
        {
            FPlatformProcess::ReturnSynchEventToPool(State->Done);
            State->Done = nullptr;
        }
    }
}
