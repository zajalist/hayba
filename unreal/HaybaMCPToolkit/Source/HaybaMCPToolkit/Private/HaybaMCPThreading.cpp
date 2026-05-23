#include "HaybaMCPThreading.h"
#include "Misc/CoreDelegates.h"
#include "Misc/ScopeLock.h"
#include "HAL/PlatformProcess.h"

namespace HaybaThreading
{
    // MPSC queue: many TCP worker threads enqueue, single game thread
    // (via OnEndFrame) dequeues.
    static TQueue<TFunction<void()>, EQueueMode::Mpsc> GQueue;

    // Subscription handle so Shutdown can cleanly remove our callback.
    static FDelegateHandle GHandle;

    // Bool guard against double-Startup (e.g. if a plugin reload calls
    // it twice). Live Coding patches the module without re-running
    // StartupModule normally, so this should never trip in practice,
    // but defensive is cheap.
    static bool bStarted = false;

    static void Drain()
    {
        // Snapshot-and-drain pattern: only process closures that were
        // already in the queue when Drain started. Closures enqueued
        // BY those closures land in the queue and process on the next
        // Drain call. This guarantees Drain terminates even if a
        // pathological handler enqueues itself, and gives nested calls
        // the same predictable next-frame semantics as TCP-side enqueues.
        TArray<TFunction<void()>> Batch;
        TFunction<void()> Item;
        while (GQueue.Dequeue(Item))
        {
            Batch.Add(MoveTemp(Item));
        }
        for (TFunction<void()>& Work : Batch)
        {
            // Each closure is independent — one throwing or asserting
            // must not skip the rest. Catch broadly; UE's editor host
            // tolerates this pattern in tick-driven code.
            Work();
        }
    }

    void Startup()
    {
        if (bStarted) return;
        bStarted = true;
        // OnEndFrame fires on the game thread after Slate/UI/world tick
        // — outside any TaskGraph queue-processing context, which is
        // exactly the window we need to avoid RecursionGuard asserts
        // when handlers do nested AsyncTask-equivalent work.
        GHandle = FCoreDelegates::OnEndFrame.AddStatic(&Drain);
    }

    void Shutdown()
    {
        if (!bStarted) return;
        bStarted = false;
        FCoreDelegates::OnEndFrame.Remove(GHandle);
        GHandle.Reset();
        // Final drain so anything queued during shutdown still runs.
        // Safe because we're called from ShutdownModule on the game
        // thread.
        Drain();
    }

    void Tick()
    {
        Drain();
    }

    void ExecuteOnGameThread(TFunction<void()> Work)
    {
        if (!Work) return;
        if (IsInGameThread())
        {
            // Already on the game thread — run inline. No TaskGraph
            // push, no queue, no possibility of re-entering anything.
            Work();
            return;
        }
        GQueue.Enqueue(MoveTemp(Work));
    }

    bool RunOnGameThreadAndWait(TFunction<void()> Work, double TimeoutSeconds)
    {
        if (!Work) return true;
        if (IsInGameThread())
        {
            // Inline — see ExecuteOnGameThread comment.
            Work();
            return true;
        }

        // Shared promise so the closure and the waiter both keep it
        // alive across the thread hop. If the wait times out and the
        // calling frame unwinds, the AsyncTask's shared ref still
        // holds the promise so SetValue is safe to call later.
        struct FBox
        {
            TPromise<void> Promise;
            bool bSet = false;
        };
        TSharedRef<FBox, ESPMode::ThreadSafe> Box =
            MakeShared<FBox, ESPMode::ThreadSafe>();
        TFuture<void> Future = Box->Promise.GetFuture();

        GQueue.Enqueue([Box, Work = MoveTemp(Work)]() mutable
        {
            // Wrap in ON_SCOPE_EXIT-equivalent — SetValue must fire
            // exactly once even if Work throws or asserts. We don't
            // use ON_SCOPE_EXIT because including Misc/ScopeExit in
            // this TU pulls in extra headers; the explicit flag does
            // the same job.
            struct FFinalizer
            {
                TSharedRef<FBox, ESPMode::ThreadSafe> Box;
                ~FFinalizer() { if (!Box->bSet) { Box->bSet = true; Box->Promise.SetValue(); } }
            };
            FFinalizer Fin{ Box };
            Work();
        });

        if (TimeoutSeconds <= 0.0)
        {
            Future.Wait();
            return true;
        }
        return Future.WaitFor(FTimespan::FromSeconds(TimeoutSeconds));
    }
}
