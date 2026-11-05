#pragma once
#include "CoreMinimal.h"

// Structured-exception guard for native calls that can fault the process.
//
// Some synchronous editor operations we invoke (RecompileMaterial,
// PostEditChange, stat extraction, …) broadcast change notifications that can
// reach a stale/destroyed callback — most often a Python-registered editor
// delegate whose target was garbage-collected — and dereference freed memory.
// That is a C-level access violation, NOT a C++/Python exception, so try/catch
// cannot stop it: it takes the whole editor down. RunGuarded wraps the call in
// Windows SEH and converts such a fault into a reported flag, keeping the
// editor alive.
//
// The thunk takes a void* context so callers can pass a CAPTURELESS lambda
// (which converts to a function pointer). TFunctionRef cannot be used: MSVC
// C2712 forbids C++ object unwinding across __try, and even a TFunctionRef
// parameter trips it on the 14.50 toolchain. Non-Windows runs the thunk directly.
namespace HaybaSeh
{
    void RunGuarded(void (*Thunk)(void*), void* Context, bool& bOutCrashed);

    // ---- Editor world-switch repair after a swallowed structured exception ----
    //
    // A caught SEH fault does NOT unwind C++ destructors for the frames between
    // the fault and the __except handler, so every RAII guard alive on that
    // stack is abandoned. The abandoned guard that kills the editor is the
    // engine's own, and it is invisible from here because we never wrote it:
    //
    //   UEditorEngine::OnScriptExecutionStart (PlayLevel.cpp) heap-allocates a
    //   FScopedConditionalWorldSwitcher whenever Blueprint script is entered on
    //   a PIE object while GWorld is still the editor world. That is exactly
    //   our situation: MCP commands drain from the core ticker, which runs
    //   AFTER UEditorEngine::Tick in the frame and therefore OUTSIDE the PIE
    //   world tick, so any command that reaches PIE Blueprint code (a console
    //   command that broadcasts into a PIE actor, python touching a PIE object,
    //   injected PIE input) trips that switch. It sets GWorld = PlayWorld and
    //   GIsPlayInEditorWorld = true, and is torn down again in
    //   UEditorEngine::OnScriptExecutionEnd.
    //
    //   When the Blueprint faults, our __except jumps straight past that
    //   teardown and GWorld stays pointing at the PIE world. The editor then
    //   dies on the NEXT frame, in the first line of UEditorEngine::Tick:
    //     check(CurrentGWorld != PlayWorld || bIsSimulatingInEditor)
    //     [EditorEngine.cpp:1758]
    //   i.e. one frame after the guard logged that the editor was kept alive.
    //   Observed twice on 2026-08-11 driving Aphrosia, via
    //   editor_run_console_command -> AphrosiaPlayerController.HandleMapModeChanged.
    //
    // So the guard must put the world state back itself. Snapshot it before the
    // guarded call; if the fault left it drifted, undo the engine's switch with
    // the engine's own inverse (RestoreEditorWorld). The stranded switcher
    // object still leaks, but its destructor is a no-op once
    // GIsPlayInEditorWorld is false, so it can never double-restore.
    //
    // This does NOT make the session healthy — the Blueprint call stack is also
    // stranded and there is no public API to pop it. It makes the editor
    // survive long enough for the caller to read the error and restart, which
    // is what the guard already claims.

    /** GWorld / GIsPlayInEditorWorld at a point in time. Trivially destructible
     *  on purpose: it has to be usable as a local in a function containing
     *  __try (MSVC C2712). World is opaque — compared, never dereferenced here. */
    struct FWorldSwitchSnapshot
    {
        const void* World = nullptr;
        bool bPlayInEditorWorld = false;
    };

    enum class EWorldSwitchDrift : uint8
    {
        /** Nothing moved. */
        None,
        /** The engine's play-world switch was never restored. Repairable. */
        StrandedPlayWorld,
        /** GWorld moved for some other reason (a map load, say). Not ours. */
        ForeignWorldChange,
    };

    /** Pure decision function, so the rule can be tested without a live editor. */
    EWorldSwitchDrift ClassifyWorldSwitchDrift(const FWorldSwitchSnapshot& Before,
                                               const FWorldSwitchSnapshot& After);

    FWorldSwitchSnapshot CaptureWorldSwitchState();

    /** Compares the current state against Before and repairs a stranded play
     *  world. Returns true only when it actually had to repair something. */
    bool RepairWorldSwitchState(const FWorldSwitchSnapshot& Before);

    // ---- Everything a caught fault strands, and the poisoned session ----
    //
    // The world switch above is not the only abandoned guard. 2026-11-05 (FoA):
    // level_save faulted inside SavePackage, the guard caught it, and the editor
    // died on the NEXT frame with "Ensure condition failed: TextData
    // [Text.cpp:311]" in the slow-task SWindow prepass, then an access
    // violation. FEditorFileUtils' FScopedSlowTask lived in a frame the
    // __except jumped over: its pointer stayed on GWarn's scope stack (pointing
    // at reused stack memory) and its dialog stayed open, so Slate read garbage
    // FText the next time it painted the dialog. SavePackage's own saving flag
    // is abandoned the same way.
    //
    // RepairAfterCaughtFault undoes the stranded state it can name, so the user
    // can still save and restart. It does NOT make the session healthy (locks,
    // CPython state, half-written objects remain), so it also poisons the
    // session: the router refuses further commands until the editor restarts.

    /** Engine state to compare against after a fault. Trivially destructible
     *  for the same C2712 reason as FWorldSwitchSnapshot. */
    struct FFaultSnapshot
    {
        FWorldSwitchSnapshot World;
        int32 SlowTaskDepth = 0;
        bool bSlowTaskDialog = false;
        bool bSavingPackage = false;
    };

    FFaultSnapshot CaptureFaultSnapshot();

    /** Repairs what a caught fault stranded relative to Before, logs loudly and
     *  poisons the session. Call only when the guard actually caught a fault. */
    void RepairAfterCaughtFault(const FFaultSnapshot& Before);

    /** Number of native faults caught in this process. Never decreases: only a
     *  restart makes the editor trustworthy again. Game thread. */
    int32 GetCaughtFaultCount();
    inline bool IsSessionPoisoned() { return GetCaughtFaultCount() > 0; }
}
