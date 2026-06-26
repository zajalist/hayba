#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformFileManager.h"
#include "pcg/HaybaUnsatCore.h"
#include "pcg/HaybaSocketSolver.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaUnsatCoreUnitTest,
    "Hayba.Socket.UnsatCore",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaUnsatCoreUnitTest::RunTest(const FString& Parameters)
{
    // Build a hard-fail outcome by hand (decoupled from the solver internals).
    FHaybaBondOutcome O;
    O.bOk = false; O.bRelaxed = false; O.Cost = HaybaSocketSolver::HardPenalty;
    O.RequirerName = FName(TEXT("branch_mouth"));
    O.ProviderName = FName(TEXT("main_wall"));
    O.MissingRequired  = { TEXT("Connection.Road") };
    O.NeighborProvided = { TEXT("Connection.Bore"), TEXT("Style.Native") };

    const FString Human = HaybaUnsatCore::BuildHuman(O);
    TestTrue(TEXT("human names requirer"),  Human.Contains(TEXT("branch_mouth")));
    TestTrue(TEXT("human names provider"),  Human.Contains(TEXT("main_wall")));
    TestTrue(TEXT("human names missing tag"), Human.Contains(TEXT("Connection.Road")));
    TestTrue(TEXT("human lists provided"),  Human.Contains(TEXT("Connection.Bore")));
    TestTrue(TEXT("human says REJECTED"),   Human.Contains(TEXT("REJECTED")));

    // Write + read back the JSON report.
    const FString Tmp = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaUnsatCoreTest.json"));
    FString Err;
    TestTrue(TEXT("write report"),
        HaybaUnsatCore::Write(O, FName(TEXT("branch_mouth")), FName(TEXT("main_wall")), Tmp, Err));

    FString Back;
    TestTrue(TEXT("read back"), FFileHelper::LoadFileToString(Back, *Tmp));
    TestTrue(TEXT("json has ok:false"), Back.Contains(TEXT("\"ok\": false")) || Back.Contains(TEXT("\"ok\":false")));
    TestTrue(TEXT("json has missing tag"), Back.Contains(TEXT("Connection.Road")));
    TestTrue(TEXT("json has human"), Back.Contains(TEXT("REJECTED")));

    FPlatformFileManager::Get().GetPlatformFile().DeleteFile(*Tmp);
    return true;
}
