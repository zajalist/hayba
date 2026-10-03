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
    Snapshot.ReadbackMs = 1.25;
    Snapshot.ReadbackWaitMs = 32.0;
    Snapshot.ReadbackGameThreadMaxMs = 0.15;
    Snapshot.BaseColorStatus = TEXT("captured");
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
    Matched.DisplayColor = FColor(205, 70, 32);
    Matched.ColorSource = HaybaWorldDepth::EColorSource::RenderedMaterialBaseColor;
    Matched.SourceActorPath = TEXT("/Scratch/Actor");
    Matched.SourceActorLabel = TEXT("Observed collision actor");
    Snapshot.AddPoint(MoveTemp(Matched));
    FPoint Scene;
    Scene.PositionCm = FVector(4.0, 5.0, 6.0);
    Scene.DisplayColor = FColor(32, 100, 210);
    Scene.ColorSource = HaybaWorldDepth::EColorSource::RenderedSceneColor;
    Snapshot.AddPoint(MoveTemp(Scene));

    TestEqual(TEXT("each spatial cell has a group"), Snapshot.Groups.Num(), 2);
    TestEqual(TEXT("only exact matched rays count as source labels"), Snapshot.MatchedRayPointCount, 1);
    TestEqual(TEXT("base-color samples are counted separately"), Snapshot.MaterialBaseColorPointCount, 1);
    TestEqual(TEXT("scene-color fallbacks are counted separately"), Snapshot.SceneColorPointCount, 1);
    TestEqual(TEXT("unobserved colors are counted separately"), Snapshot.UnobservedColorPointCount, 1);
    const TSharedRef<FJsonObject> Groups = BuildPage(Snapshot, TEXT("groups"), 1, 1, FString());
    TestEqual(TEXT("group page is bounded"), Groups->GetArrayField(TEXT("items")).Num(), 1);
    TestEqual(TEXT("group total spans all pages"),
        static_cast<int32>(Groups->GetNumberField(TEXT("total_items"))), 2);
    const TSharedRef<FJsonObject> Points = BuildPage(Snapshot, TEXT("points"), 0, 32, FString());
    TestEqual(TEXT("readback mode describes asynchronous staging"),
        Points->GetStringField(TEXT("readback_mode")),
        FString(TEXT("async_gpu_staging_render_thread_copy")));
    TestEqual(TEXT("game-thread readback poll cost is exposed separately"),
        Points->GetNumberField(TEXT("readback_game_thread_max_ms")), 0.15);
    TestEqual(TEXT("base-color capture status is explicit"),
        Points->GetStringField(TEXT("base_color_status")), FString(TEXT("captured")));
    TestTrue(TEXT("mixed color provenance marks color coverage partial"),
        Points->GetObjectField(TEXT("coverage"))->GetBoolField(TEXT("color_partial")));
    const TArray<TSharedPtr<FJsonValue>>& Rows = Points->GetArrayField(TEXT("items"));
    TestEqual(TEXT("unknown point declares unknown attribution"),
        Rows[0]->AsObject()->GetStringField(TEXT("source_attribution")), FString(TEXT("unknown")));
    TestFalse(TEXT("unknown point has no actor label"), Rows[0]->AsObject()->HasField(TEXT("source_actor_label")));
    TestEqual(TEXT("unobserved color is labelled"),
        Rows[0]->AsObject()->GetStringField(TEXT("color_provenance")), FString(TEXT("unobserved")));
    TestFalse(TEXT("unobserved point has no sampled RGB"), Rows[0]->AsObject()->HasField(TEXT("display_rgb")));
    TestEqual(TEXT("matched ray carries a source label"),
        Rows[1]->AsObject()->GetStringField(TEXT("source_actor_label")),
        FString(TEXT("Observed collision actor")));
    TestFalse(TEXT("depth page has no mesh-local index"), Rows[1]->AsObject()->HasField(TEXT("node_index")));
    TestFalse(TEXT("depth page has no inferred mesh asset"), Rows[1]->AsObject()->HasField(TEXT("mesh_asset")));
    TestEqual(TEXT("base-color RGB has rendered material provenance"),
        Rows[1]->AsObject()->GetStringField(TEXT("color_provenance")),
        FString(TEXT("rendered_material_base_color_visible_surface")));
    TestEqual(TEXT("observed RGB is paged with the depth point"),
        static_cast<int32>(Rows[1]->AsObject()->GetArrayField(TEXT("display_rgb"))[0]->AsNumber()), 205);
    TestEqual(TEXT("scene fallback stays distinguishable from material BaseColor"),
        Rows[2]->AsObject()->GetStringField(TEXT("color_provenance")),
        FString(TEXT("rendered_scene_color_visible_surface")));
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
