#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldInspectSummary.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldInspectSummaryTest, "Hayba.MCP.World.InspectSummary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldInspectSummaryTest::RunTest(const FString&)
{
    TSharedRef<FJsonObject> Data = MakeShared<FJsonObject>();
    TSharedRef<FJsonObject> World = MakeShared<FJsonObject>();
    World->SetStringField(TEXT("package"), TEXT("/Game/L_Clinic"));
    World->SetStringField(TEXT("current_level"), TEXT("/Game/L_Clinic_Interior"));
    Data->SetObjectField(TEXT("world"), World);
    TSharedRef<FJsonObject> Partition = MakeShared<FJsonObject>();
    Partition->SetBoolField(TEXT("enabled"), true);
    Data->SetObjectField(TEXT("partition"), Partition);
    TArray<TSharedPtr<FJsonValue>> Landscapes;
    Landscapes.Add(MakeShared<FJsonValueObject>(MakeShared<FJsonObject>()));
    Data->SetArrayField(TEXT("landscape"), Landscapes);
    Data->SetBoolField(TEXT("save_ready"), false);

    const FHaybaWorldInspectSummary Valid = FHaybaWorldInspectSummary::FromResponse(true, Data);
    TestTrue(TEXT("valid native response succeeds"), Valid.bSuccess);
    TestEqual(TEXT("map package"), Valid.LevelPackage, FString(TEXT("/Game/L_Clinic")));
    TestEqual(TEXT("current level package"), Valid.CurrentLevelPackage, FString(TEXT("/Game/L_Clinic_Interior")));
    TestTrue(TEXT("partition enabled"), Valid.bPartitionEnabled);
    TestEqual(TEXT("loaded landscape count"), Valid.LoadedLandscapeCount, 1);
    TestFalse(TEXT("save readiness is not invented"), Valid.bSaveReady);
    const FString Text = Valid.ToConversationText();
    TestTrue(TEXT("summary names the current map"), Text.Contains(TEXT("/Game/L_Clinic")));
    TestTrue(TEXT("save check names the level it checks"), Text.Contains(TEXT("Current level file (/Game/L_Clinic_Interior): not confirmed writable")));
    TestTrue(TEXT("summary names loaded landscapes"), Text.Contains(TEXT("Loaded landscapes: 1")));
    TestTrue(TEXT("summary names partition"), Text.Contains(TEXT("World Partition: enabled")));
    TestTrue(TEXT("summary reports save uncertainty"), Text.Contains(TEXT("not confirmed writable")));
    TestTrue(TEXT("summary labels unloaded cells unknown"), Text.Contains(TEXT("unloaded partition cells not inspected")));

    const FHaybaWorldInspectSummary Failed = FHaybaWorldInspectSummary::FromResponse(false, Data);
    TestFalse(TEXT("failed native command is not success"), Failed.bSuccess);
    TestTrue(TEXT("failed command has actionable text"), Failed.ToConversationText().Contains(TEXT("try again")));
    TSharedRef<FJsonObject> MissingWorld = MakeShared<FJsonObject>();
    MissingWorld->SetObjectField(TEXT("partition"), Partition);
    TestFalse(TEXT("missing world rejected"), FHaybaWorldInspectSummary::FromResponse(true, MissingWorld).bSuccess);
    TSharedRef<FJsonObject> MissingPartition = MakeShared<FJsonObject>();
    MissingPartition->SetObjectField(TEXT("world"), World);
    TestFalse(TEXT("missing partition rejected"), FHaybaWorldInspectSummary::FromResponse(true, MissingPartition).bSuccess);

    FHaybaInspectRequestGeneration Requests;
    const uint64 First = Requests.Begin();
    const uint64 Second = Requests.Begin();
    TestFalse(TEXT("older response cannot replace latest inspection"), Requests.IsCurrent(First));
    TestTrue(TEXT("latest response remains current"), Requests.IsCurrent(Second));
    Requests.Invalidate();
    TestFalse(TEXT("conversation change invalidates in-flight inspection"), Requests.IsCurrent(Second));
    return true;
}
#endif
