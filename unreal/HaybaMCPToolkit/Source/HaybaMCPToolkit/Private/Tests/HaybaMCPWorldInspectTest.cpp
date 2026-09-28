#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Engine/Level.h"
#include "UObject/Package.h"
#include "handlers/HaybaMCPWorldPartitionHandler.h"
#include "handlers/HaybaMCPLevelHandler.h"
#include "HaybaMCPCommandHandler.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPWorldInspectTest,
    "Hayba.MCP.WorldInspect.NonPartitionedSnapshot",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPWorldInspectTest::RunTest(const FString&)
{
    if (!TestNotNull(TEXT("Editor is available"), GEditor)) return false;
    UWorld* TestWorld = UWorld::CreateWorld(EWorldType::Editor, false);
    if (!TestNotNull(TEXT("Transient editor world created"), TestWorld)) return false;
    UWorld* PreviousWorld = GEditor->GetEditorWorldContext().World();
    GEditor->GetEditorWorldContext().SetCurrentWorld(TestWorld);
    ON_SCOPE_EXIT
    {
        GEditor->GetEditorWorldContext().SetCurrentWorld(PreviousWorld);
        TestWorld->DestroyWorld(false);
    };

    FHaybaMCPWorldPartitionHandler Handler;
    TestTrue(TEXT("Snapshot command is registered"), Handler.GetCommands().Contains(TEXT("world_inspect")));
    const bool bWasDirty = TestWorld->GetPackage()->IsDirty();
    const int32 ActorCount = TestWorld->PersistentLevel->Actors.Num();
    const FHaybaHandlerResult Result = Handler.Handle(TEXT("world_inspect"), MakeShared<FJsonObject>());
    if (!TestTrue(TEXT("Snapshot succeeds"), Result.bOk) || !Result.Data.IsValid()) return false;

    const TSharedPtr<FJsonObject>* Partition = nullptr;
    if (TestTrue(TEXT("Partition object is present"), Result.Data->TryGetObjectField(TEXT("partition"), Partition)))
    {
        bool bEnabled = true;
        TestTrue(TEXT("Partition enabled is a boolean"), (*Partition)->TryGetBoolField(TEXT("enabled"), bEnabled));
        TestFalse(TEXT("New editor world is not partitioned"), bEnabled);
        const TArray<TSharedPtr<FJsonValue>>* Grids = nullptr;
        if (TestTrue(TEXT("Runtime grids array is present"), (*Partition)->TryGetArrayField(TEXT("runtime_grids"), Grids)))
            TestEqual(TEXT("Non-partitioned world has no grids"), Grids->Num(), 0);
    }
    const TSharedPtr<FJsonObject>* WorldInfo = nullptr;
    if (TestTrue(TEXT("World metadata is present"), Result.Data->TryGetObjectField(TEXT("world"), WorldInfo)))
    {
        TestEqual(TEXT("World type"), (*WorldInfo)->GetStringField(TEXT("type")), FString(TEXT("Editor")));
        TestEqual(TEXT("World package"), (*WorldInfo)->GetStringField(TEXT("package")), TestWorld->GetPackage()->GetName());
        TestEqual(TEXT("Current level package"), (*WorldInfo)->GetStringField(TEXT("current_level")), TestWorld->GetCurrentLevel()->GetOutermost()->GetName());
    }
    const TSharedPtr<FJsonObject>* Hlod = nullptr;
    if (TestTrue(TEXT("HLOD object is present"), Result.Data->TryGetObjectField(TEXT("hlod"), Hlod)))
    {
        const TArray<TSharedPtr<FJsonValue>>* Layers = nullptr;
        if (TestTrue(TEXT("HLOD layers array is present"), (*Hlod)->TryGetArrayField(TEXT("layers"), Layers)))
            TestEqual(TEXT("Non-partitioned world has no HLOD layers"), Layers->Num(), 0);
    }
    const TSharedPtr<FJsonObject>* Capabilities = nullptr;
    if (TestTrue(TEXT("Capabilities are present"), Result.Data->TryGetObjectField(TEXT("capabilities"), Capabilities)))
    {
        for (const TCHAR* Name : { TEXT("world_partition"), TEXT("hlod"), TEXT("web_browser") })
        {
            bool bAvailable = false;
            TestTrue(FString::Printf(TEXT("%s is an explicit boolean"), Name),
                (*Capabilities)->TryGetBoolField(Name, bAvailable));
        }
    }
    for (const TCHAR* Name : { TEXT("landscape"), TEXT("data_layers") })
    {
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        if (TestTrue(FString::Printf(TEXT("%s is an array"), Name), Result.Data->TryGetArrayField(Name, Values)))
        {
            TestEqual(FString::Printf(TEXT("%s is empty"), Name), Values->Num(), 0);
        }
    }
    bool bSaveReady = true;
    TestTrue(TEXT("Save readiness is a boolean"), Result.Data->TryGetBoolField(TEXT("save_ready"), bSaveReady));
    TestFalse(TEXT("Transient map needs a save path"), bSaveReady);
    TestEqual(TEXT("Inspection preserves package dirty state"), TestWorld->GetPackage()->IsDirty(), bWasDirty);
    TestEqual(TEXT("Inspection preserves actors"), TestWorld->PersistentLevel->Actors.Num(), ActorCount);

    // The world and current level can belong to different packages. Save must
    // refuse a different target before sanitizing references or touching disk.
    UPackage* SublevelPackage = CreatePackage(TEXT("/Temp/HaybaWorldInspectSublevel"));
    ULevel* Sublevel = NewObject<ULevel>(SublevelPackage, TEXT("ReviewSublevel"));
    ULevel* PreviousLevel = TestWorld->GetCurrentLevel();
    TestWorld->SetCurrentLevel(Sublevel);
    ON_SCOPE_EXIT { TestWorld->SetCurrentLevel(PreviousLevel); };
    const FHaybaHandlerResult SublevelResult = Handler.Handle(TEXT("world_inspect"), MakeShared<FJsonObject>());
    if (SublevelResult.bOk && SublevelResult.Data.IsValid())
    {
        const auto Info = SublevelResult.Data->GetObjectField(TEXT("world"));
        TestEqual(TEXT("Sublevel is the current save target"), Info->GetStringField(TEXT("current_level")), SublevelPackage->GetName());
        TestEqual(TEXT("World identity remains separate"), Info->GetStringField(TEXT("package")), TestWorld->GetPackage()->GetName());
    }
    else AddError(TEXT("Sublevel inspection failed"));
    auto SaveParams = MakeShared<FJsonObject>();
    SaveParams->SetStringField(TEXT("path"), TEXT("/Game/DefinitelyNotTheCurrentLevel"));
    FHaybaMCPLevelHandler LevelHandler;
    const bool bSublevelWasDirty = SublevelPackage->IsDirty();
    TestFalse(TEXT("Save refuses a different target"), LevelHandler.Handle(TEXT("level_save"), SaveParams).bOk);
    TestEqual(TEXT("Refused save preserves dirty state"), SublevelPackage->IsDirty(), bSublevelWasDirty);
    TestTrue(TEXT("LOD writes use editor transactions"), FHaybaMCPCommandHandler::ShouldCreateEditorTransaction(TEXT("mesh_set_lod")));
    TestFalse(TEXT("Disk persistence does not claim an undo transaction"), FHaybaMCPCommandHandler::ShouldCreateEditorTransaction(TEXT("level_save")));

    GEditor->GetEditorWorldContext().SetCurrentWorld(nullptr);
    TestFalse(TEXT("Missing editor world is an error"),
        Handler.Handle(TEXT("world_inspect"), MakeShared<FJsonObject>()).bOk);
    return true;
}

#endif
