#pragma once

#include "CoreMinimal.h"
#include "Containers/Queue.h"
#include "Async/Future.h"

class FDelegateHandle;

/**
 * Game-thread dispatcher — the single place plugin code marshals work
 * onto the game thread.
 *
 * Why this exists: `AsyncTask(ENamedThreads::GameThread, ...)` pushes
 * to UE's TaskGraph queue, which asserts on re-entrant pushes via
 *   Assertion failed: ++Queue(QueueIndex).RecursionGuard == 1
 *   TaskGraph.cpp:689
 * when something already-on-the-game-thread tries to enqueue more
 * game-thread work. Two MCP sessions in May 2026 crashed UE this way:
 * once when a handler that ran via AsyncTask called AsyncTask again
 * internally; and once when a TCP-serialised handler did the same.
 *
 * This dispatcher sidesteps the entire RecursionGuard family by NOT
 * using the TaskGraph at all. Workers enqueue closures into an MPSC
 * queue; a callback subscribed to FCoreDelegates::OnEndFrame drains
 * the queue once per frame, OUTSIDE any TaskGraph processing context.
 * Closures that themselves want to schedule more game-thread work go
 * through the same helpers; nested calls inline if already on the
 * game thread.
 *
 * Rule for plugin code:
 *   - Never call `AsyncTask(ENamedThreads::GameThread, ...)` directly.
 *     Always call ExecuteOnGameThread() or RunOnGameThreadAndWait().
 *   - The lint at mcp-tools/hayba-mcp/scripts/check-no-raw-gamethread-asynctask
 *     (added alongside this file) flags violations in CI.
 */
namespace HaybaThreading
{
    /**
     * Schedule Work to run on the game thread. If the caller is
     * already on the game thread, Work runs inline (no queueing). The
     * inline path is what makes nested calls from within handlers
     * safe — no TaskGraph push, no re-entry possible.
     *
     * Fire-and-forget; the caller does not wait for completion.
     */
    HAYBAMCPTOOLKIT_API void ExecuteOnGameThread(TFunction<void()> Work);

    /**
     * Run Work on the game thread and wait for it to finish. If the
     * caller is already on the game thread, Work runs inline and the
     * function returns immediately (no future, no wait). Otherwise,
     * Work is enqueued and the calling thread blocks on a TPromise
     * until the dispatcher drains it.
     *
     * TimeoutSeconds <= 0 means wait forever. Returns true if Work
     * completed, false if the wait timed out. On timeout the closure
     * remains in the queue and will still execute on a future drain
     * — make Work idempotent or capture by shared_ptr if you care.
     */
    HAYBAMCPTOOLKIT_API bool RunOnGameThreadAndWait(
        TFunction<void()> Work,
        double TimeoutSeconds = 30.0);

    /**
     * Lifecycle. Called once from FHaybaMCPModule::StartupModule
     * (subscribes to OnEndFrame) and once from ShutdownModule
     * (unsubscribes, drains the queue one last time). Tests can call
     * the Tick() helper directly to drain without an OnEndFrame.
     */
    HAYBAMCPTOOLKIT_API void Startup();
    HAYBAMCPTOOLKIT_API void Shutdown();
    HAYBAMCPTOOLKIT_API void Tick();
}
