#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformFileManager.h"
#include "pcg/HaybaSocketStore.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaSocketStoreUnitTest,
    "Hayba.Socket.Store",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaSocketStoreUnitTest::RunTest(const FString& Parameters)
{
    const FString Tmp = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaSocketStoreTest.json"));
    const FString Json = TEXT(R"JSON(
{
  "sockets": {
    "main_wall":    { "provides": ["Connection.Bore","Style.Native"], "requires_all": ["Connection.Bore"], "requires_exclude": [], "polarity": "female", "cost_weight": 1.0, "relaxable": true },
    "branch_mouth": { "provides": ["Connection.Bore","Style.Native"], "requires_all": ["Connection.Road"], "requires_exclude": [], "polarity": "male",   "cost_weight": 1.0, "relaxable": false }
  },
  "bond": { "frontier": "branch_mouth", "candidate": "main_wall" }
}
)JSON");
    TestTrue(TEXT("write temp"), FFileHelper::SaveStringToFile(Json, *Tmp));

    FHaybaSocketSet Set; FString Err;
    const bool bOk = HaybaSocketStore::Load(Tmp, Set, Err);
    TestTrue(FString::Printf(TEXT("load ok (%s)"), *Err), bOk);
    TestEqual(TEXT("two sockets"), Set.Sockets.Num(), 2);
    TestEqual(TEXT("bond frontier"),  Set.BondFrontier,  FName(TEXT("branch_mouth")));
    TestEqual(TEXT("bond candidate"), Set.BondCandidate, FName(TEXT("main_wall")));

    const FHaybaSocketContract* Branch = Set.Sockets.Find(FName(TEXT("branch_mouth")));
    TestNotNull(TEXT("branch present"), Branch);
    if (Branch)
    {
        TestEqual(TEXT("branch requires Road"), Branch->Requires.All.Num() == 1 ? Branch->Requires.All[0] : FString(), FString(TEXT("Connection.Road")));
        TestFalse(TEXT("branch is hard (relaxable=false)"), Branch->bRelaxable);
        TestEqual(TEXT("branch polarity"), Branch->Polarity, FString(TEXT("male")));
    }

    // Missing file -> false + message, no crash.
    FHaybaSocketSet Set2; FString Err2;
    TestFalse(TEXT("missing file fails"), HaybaSocketStore::Load(Tmp + TEXT(".nope"), Set2, Err2));
    TestTrue(TEXT("error message set"), !Err2.IsEmpty());

    FPlatformFileManager::Get().GetPlatformFile().DeleteFile(*Tmp);
    return true;
}
