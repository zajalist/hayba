#include "Misc/AutomationTest.h"
#include "HaybaMCPViewDepthSnapshot.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaViewDepthSnapshotTest,
    "Hayba.MCP.World.ViewDepthSnapshot",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaViewDepthSnapshotTest::RunTest(const FString&)
{
    using namespace HaybaViewDepthSnapshot;
    TestEqual(TEXT("negative position floors into negative spatial cell"),
        GroupIdFor(CellFor(FVector(-1.0, 0.0, 0.0))), FString(TEXT("cell:-1:0:0")));

    FSnapshot Snapshot;
    Snapshot.CaptureId = TEXT("0123456789abcdef0123456789abcdef");
    Snapshot.Status = TEXT("complete_visible_subset");
    Snapshot.bCameraValid = true;
    Snapshot.CameraCm = FVector(100.0, 200.0, 300.0);
    Snapshot.HorizontalFovDegrees = 90.0;
    FPoint Unknown;
    Unknown.PositionCm = FVector(1.0, 2.0, 3.0);
    Unknown.PixelX = 3;
    Unknown.PixelY = 4;
    Unknown.DepthCm = 700.0;
    Snapshot.AddPoint(MoveTemp(Unknown));
    FPoint Matched;
    Matched.PositionCm = FVector(-1.0, 2.0, 3.0);
    Matched.PixelX = 8;
    Matched.PixelY = 8;
    Matched.DepthCm = 900.0;
    Matched.SourceActorPath = TEXT("/Scratch/Actor");
    Matched.SourceActorLabel = TEXT("Observed collision actor");
    Snapshot.AddPoint(MoveTemp(Matched));

    TestEqual(TEXT("each spatial cell has a group"), Snapshot.Groups.Num(), 2);
    TestEqual(TEXT("only exact matched rays count as source labels"), Snapshot.MatchedRayPointCount, 1);
    const TSharedRef<FJsonObject> Groups = BuildPage(Snapshot, TEXT("groups"), 1, 1, FString());
    TestEqual(TEXT("group page is bounded"), Groups->GetArrayField(TEXT("items")).Num(), 1);
    TestEqual(TEXT("group total spans all pages"),
        static_cast<int32>(Groups->GetNumberField(TEXT("total_items"))), 2);
    const TSharedRef<FJsonObject> Points = BuildPage(Snapshot, TEXT("points"), 0, 32, FString());
    const TArray<TSharedPtr<FJsonValue>>& Rows = Points->GetArrayField(TEXT("items"));
    TestEqual(TEXT("unknown point declares unknown attribution"),
        Rows[0]->AsObject()->GetStringField(TEXT("source_attribution")), FString(TEXT("unknown")));
    TestFalse(TEXT("unknown point has no actor label"), Rows[0]->AsObject()->HasField(TEXT("source_actor_label")));
    TestEqual(TEXT("matched ray carries a source label"),
        Rows[1]->AsObject()->GetStringField(TEXT("source_actor_label")),
        FString(TEXT("Observed collision actor")));
    TestFalse(TEXT("depth page has no mesh-local index"), Rows[1]->AsObject()->HasField(TEXT("node_index")));
    TestFalse(TEXT("depth page has no inferred mesh asset"), Rows[1]->AsObject()->HasField(TEXT("mesh_asset")));
    const TSharedRef<FJsonObject> Filtered = BuildPage(Snapshot, TEXT("points"), 0, 32, TEXT("cell:-1:0:0"));
    TestEqual(TEXT("spatial group filter returns its one point"),
        Filtered->GetArrayField(TEXT("items")).Num(), 1);
    TestEqual(TEXT("spatial group total is filter scoped"),
        static_cast<int32>(Filtered->GetNumberField(TEXT("total_items"))), 1);

    const TSharedRef<FJsonObject> Missing = BuildNotCaptured();
    TestEqual(TEXT("no observation is explicit"), Missing->GetStringField(TEXT("status")),
        FString(TEXT("not_captured")));
    TestTrue(TEXT("missing capture ID is null"), Missing->HasTypedField<EJson::Null>(TEXT("capture_id")));
    return true;
}
#endif
