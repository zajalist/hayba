// The rule that keeps a swallowed access violation from killing the editor a
// frame later.
//
// HaybaSeh::RunGuarded converts a native fault into an error envelope, but the
// __except that does it skips every C++ destructor between the fault and the
// handler — including the engine's own heap-allocated
// FScopedConditionalWorldSwitcher, which UEditorEngine::OnScriptExecutionStart
// pushes whenever an MCP command reaches Blueprint code on a PIE object. Left
// pushed, GWorld stays on the PIE world and UEditorEngine::Tick asserts on the
// next frame (EditorEngine.cpp:1758) — one frame after the guard reported the
// editor kept alive. Observed twice on 2026-08-11 driving Aphrosia.
//
// The repair itself needs a live editor to prove. The DECISION — which drift is
// ours to undo — is pure, and is what this pins: undo only the case where we
// entered in the editor world and came out in a play world. Undoing any other
// drift would leak the opposite way, restoring a world somebody else pushed.

#include "Misc/AutomationTest.h"
#include "HaybaMCPSeh.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace
{
    HaybaSeh::FWorldSwitchSnapshot Snap(const void* World, bool bPlayInEditor)
    {
        HaybaSeh::FWorldSwitchSnapshot S;
        S.World = World;
        S.bPlayInEditorWorld = bPlayInEditor;
        return S;
    }

    // Two distinct non-null addresses standing in for the editor and PIE worlds.
    // Never dereferenced — the classifier only ever compares them.
    const void* const EditorWorld = reinterpret_cast<const void*>(0x1000);
    const void* const PieWorld    = reinterpret_cast<const void*>(0x2000);

    // TestEqual has no enum-class overload, and a failure printed as "0 != 1"
    // says nothing about which rule broke.
    FString DriftName(HaybaSeh::EWorldSwitchDrift Drift)
    {
        switch (Drift)
        {
        case HaybaSeh::EWorldSwitchDrift::None:               return TEXT("None");
        case HaybaSeh::EWorldSwitchDrift::StrandedPlayWorld:  return TEXT("StrandedPlayWorld");
        case HaybaSeh::EWorldSwitchDrift::ForeignWorldChange: return TEXT("ForeignWorldChange");
        default:                                              return TEXT("<unknown>");
        }
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSehWorldSwitchDriftTest,
    "Hayba.MCP.Seh.WorldSwitchDriftClassification",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSehWorldSwitchDriftTest::RunTest(const FString&)
{
    using namespace HaybaSeh;

    // A fault that never touched the world needs no repair. Most faults are
    // this, and repairing them anyway would be a swap of its own.
    TestEqual(TEXT("unchanged editor world is not drift"),
        DriftName(ClassifyWorldSwitchDrift(Snap(EditorWorld, false), Snap(EditorWorld, false))),
        DriftName(EWorldSwitchDrift::None));

    // The crash. Entered in the editor world, came out inside the PIE world
    // because the engine's switcher was abandoned mid-Blueprint.
    TestEqual(TEXT("editor world in, play world out is the stranded switch"),
        DriftName(ClassifyWorldSwitchDrift(Snap(EditorWorld, false), Snap(PieWorld, true))),
        DriftName(EWorldSwitchDrift::StrandedPlayWorld));

    // Already inside a play world on entry: that switch belongs to whoever
    // pushed it and is theirs to pop. Restoring here would strand the editor
    // world instead — the same bug pointing the other way.
    TestEqual(TEXT("already in the play world on entry is not ours to undo"),
        DriftName(ClassifyWorldSwitchDrift(Snap(PieWorld, true), Snap(PieWorld, true))),
        DriftName(EWorldSwitchDrift::None));

    TestEqual(TEXT("play world in, editor world out is not ours to undo"),
        DriftName(ClassifyWorldSwitchDrift(Snap(PieWorld, true), Snap(EditorWorld, false))),
        DriftName(EWorldSwitchDrift::ForeignWorldChange));

    // GWorld replaced without the play-in-editor flag moving is a map load or
    // world teardown, not an abandoned PIE switch. RestoreEditorWorld would
    // assert on its own check(GIsPlayInEditorWorld) if we tried.
    TestEqual(TEXT("world swapped with the flag unmoved is a foreign change"),
        DriftName(ClassifyWorldSwitchDrift(Snap(EditorWorld, false), Snap(PieWorld, false))),
        DriftName(EWorldSwitchDrift::ForeignWorldChange));

    return true;
}

#endif  // WITH_DEV_AUTOMATION_TESTS
