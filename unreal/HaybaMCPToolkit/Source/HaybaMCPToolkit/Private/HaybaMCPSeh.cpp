#include "HaybaMCPSeh.h"
#include "HaybaMCPEditorHealth.h"   // RecordCaughtFault, called after the guard returns
#if PLATFORM_WINDOWS
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER
#endif

#include "Editor.h"           // RestoreEditorWorld, GEditor
#include "Editor/EditorEngine.h"   // UEditorEngine::GetEditorWorldContext
#include "Engine/World.h"     // GWorld (UWorldProxy), UWorld
#include "Misc/FeedbackContext.h"  // GWarn scope stack, FinalizeSlowTask
#include "Misc/SlowTaskStack.h"
#include "UObject/UObjectGlobals.h"  // UE::IsSavingPackage / SetIsSavingPackage

DEFINE_LOG_CATEGORY_STATIC(LogHaybaSeh, Log, All);

namespace HaybaSeh
{
namespace
{
    // The __try lives alone in this function so nothing else can trip MSVC
    // C2712 ("cannot use __try in functions that require object unwinding").
    // It has no locals at all beyond the parameters. The filter only stores
    // the exception code into a parameter; everything that records the fault
    // runs in RunGuardedAt after this returns.
    void RunGuardedRaw(void (*Thunk)(void*), void* Context, bool& bOutCrashed, uint32& OutCode)
    {
#if PLATFORM_WINDOWS
        __try
        {
            Thunk(Context);
        }
        __except (OutCode = GetExceptionCode(), EXCEPTION_EXECUTE_HANDLER)
        {
            bOutCrashed = true;
        }
#else
        Thunk(Context);
#endif
    }
}

    EWorldSwitchDrift ClassifyWorldSwitchDrift(const FWorldSwitchSnapshot& Before,
                                               const FWorldSwitchSnapshot& After)
    {
        if (Before.bPlayInEditorWorld == After.bPlayInEditorWorld && Before.World == After.World)
        {
            return EWorldSwitchDrift::None;
        }

        // The only drift we own is "we were in the editor world, and the fault
        // left us in a play world". Anything else — including a play world we
        // were already inside when the guarded call started — belongs to
        // whoever pushed it, and undoing it here would leak the opposite way.
        if (!Before.bPlayInEditorWorld && After.bPlayInEditorWorld)
        {
            return EWorldSwitchDrift::StrandedPlayWorld;
        }

        return EWorldSwitchDrift::ForeignWorldChange;
    }

    FWorldSwitchSnapshot CaptureWorldSwitchState()
    {
        // GWorld is a UWorldProxy, not a raw pointer; go through its UWorld*
        // conversion rather than casting the proxy itself. It can legitimately
        // be null (CoreGlobals notes GIsPlayInEditorWorld can be true with a
        // null GWorld during LoadMap), which the repair path handles.
        UWorld* const Current = GWorld;

        FWorldSwitchSnapshot Snapshot;
        Snapshot.World = static_cast<const void*>(Current);
        Snapshot.bPlayInEditorWorld = GIsPlayInEditorWorld;
        return Snapshot;
    }

    bool RepairWorldSwitchState(const FWorldSwitchSnapshot& Before)
    {
        const FWorldSwitchSnapshot After = CaptureWorldSwitchState();

        switch (ClassifyWorldSwitchDrift(Before, After))
        {
        case EWorldSwitchDrift::StrandedPlayWorld:
        {
            // Restore to the world that was current before the guarded call:
            // that is precisely the OldWorld the abandoned
            // FScopedConditionalWorldSwitcher captured and would have put back.
            // Fall back to the editor world context only if that snapshot is
            // somehow null — RestoreEditorWorld(nullptr) would trade this
            // assert for check(CurrentGWorld) on the same line.
            UWorld* Target = const_cast<UWorld*>(static_cast<const UWorld*>(Before.World));
            if (!Target && GEditor)
            {
                Target = GEditor->GetEditorWorldContext().World();
            }
            if (!Target)
            {
                UE_LOG(LogHaybaSeh, Error,
                    TEXT("SEH guard: a caught fault stranded GWorld in the play world and there is no world to "
                         "restore to. The editor will assert on the next tick (EditorEngine.cpp:1758). Restart it."));
                return false;
            }

            RestoreEditorWorld(Target);

            UE_LOG(LogHaybaSeh, Warning,
                TEXT("SEH guard: a caught fault abandoned the engine's play-world switch "
                     "(UEditorEngine::OnScriptExecutionStart). GWorld was left pointing at the PIE world, which "
                     "asserts in UEditorEngine::Tick on the next frame; restored it to the editor world. The "
                     "Blueprint call stack is still stranded — treat this session as suspect and restart it."));
            return true;
        }

        case EWorldSwitchDrift::ForeignWorldChange:
            UE_LOG(LogHaybaSeh, Warning,
                TEXT("SEH guard: GWorld changed across a caught fault in a way this guard does not own "
                     "(play-in-editor %d -> %d). Leaving it alone; the session is suspect, restart the editor."),
                Before.bPlayInEditorWorld ? 1 : 0, After.bPlayInEditorWorld ? 1 : 0);
            return false;

        case EWorldSwitchDrift::None:
        default:
            return false;
        }
    }

namespace
{
    // FinalizeSlowTask is protected on FFeedbackContext; naming it through a
    // derived class is the standard way to call it (virtually) from outside.
    struct FFeedbackContextAccess : FFeedbackContext
    {
        static void Finalize(FFeedbackContext& Context)
        {
            void (FFeedbackContext::*Fn)() = &FFeedbackContextAccess::FinalizeSlowTask;
            (Context.*Fn)();
        }
    };
}

    FFaultSnapshot CaptureFaultSnapshot()
    {
        FFaultSnapshot Snapshot;
        Snapshot.World = CaptureWorldSwitchState();
        Snapshot.SlowTaskDepth = GWarn ? GWarn->GetScopeStack().Num() : 0;
        Snapshot.bSlowTaskDialog = GIsSlowTask;
        Snapshot.bSavingPackage = UE::IsSavingPackage();
        return Snapshot;
    }

    void RepairStrandedEngineState(const FFaultSnapshot& Before)
    {
        if (GWarn)
        {
            // Entries above the snapshot depth point into stack frames the
            // __except discarded. Drop them without touching them.
            FSlowTaskStack& Stack = const_cast<FSlowTaskStack&>(GWarn->GetScopeStack());
            if (Stack.Num() > Before.SlowTaskDepth)
            {
                UE_LOG(LogHaybaSeh, Error,
                    TEXT("SEH guard: dropped %d abandoned slow task(s) from the editor's progress stack."),
                    Stack.Num() - Before.SlowTaskDepth);
                Stack.SetNum(Before.SlowTaskDepth, EAllowShrinking::No);
            }
            // The abandoned task owned the progress dialog; nothing else will close it.
            if (!Before.bSlowTaskDialog && GIsSlowTask)
            {
                FFeedbackContextAccess::Finalize(*GWarn);
                UE_LOG(LogHaybaSeh, Error, TEXT("SEH guard: closed the progress dialog the faulting call left open."));
            }
        }

        if (!Before.bSavingPackage && UE::IsSavingPackage())
        {
            // An abandoned FScopedSavingFlag leaves this set, and every later
            // StaticFindObject treats the editor as mid-save (fatal).
            UE::SetIsSavingPackage(false);
            UE_LOG(LogHaybaSeh, Error, TEXT("SEH guard: cleared the saving-package flag the faulting save left set."));
        }
    }

    void RunGuardedAt(EHaybaFaultSite Site, void (*Thunk)(void*), void* Context, bool& bOutCrashed)
    {
        bOutCrashed = false;
        if (!Thunk) return;

        const FFaultSnapshot Before = CaptureFaultSnapshot();
        uint32 ExceptionCode = 0;
        RunGuardedRaw(Thunk, Context, bOutCrashed, ExceptionCode);
        if (bOutCrashed)
        {
            const bool bRepaired = RepairWorldSwitchState(Before.World);
            // Record before clearing the saving flag, so the health record still
            // sees a fault that stranded a save.
            FHaybaEditorHealth::RecordCaughtFault(Site, ExceptionCode, bRepaired);
            RepairStrandedEngineState(Before);
        }
    }

    void RunGuarded(void (*Thunk)(void*), void* Context, bool& bOutCrashed)
    {
        RunGuardedAt(EHaybaFaultSite::HandlerInner, Thunk, Context, bOutCrashed);
    }
}
