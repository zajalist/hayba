#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldRelations.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldRelationsTest,
    "Hayba.MCP.World.CapturedRelations",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldRelationsTest::RunTest(const FString& Parameters)
{
    HaybaWorldTileSnapshot::FTile Tile;
    Tile.TileId = TEXT("tile:2:0:0:0");
    Tile.CaptureId = TEXT("0123456789abcdef0123456789abcdef");
    Tile.PointCount = 8;
    HaybaWorldTileSnapshot::FPage Page;
    Page.PageId = 7;
    for (const TCHAR* Id : {TEXT("/A"), TEXT("/B"), TEXT("/C"), TEXT("/D")})
    {
        HaybaWorldGeometry::FNode& Node = Page.Geometry.Nodes.AddDefaulted_GetRef();
        Node.Id = Id;
        Node.Kind = TEXT("component");
    }
    auto AddPoint = [&Page](int32 NodeIndex, const FVector& Position)
    {
        HaybaWorldGeometry::FSplat& Point = Page.Geometry.Splats.AddDefaulted_GetRef();
        Point.NodeIndex = NodeIndex;
        Point.PositionCm = Position;
    };
    AddPoint(0, FVector(0, 0, 0));
    AddPoint(0, FVector(100, 100, 100));
    AddPoint(1, FVector(150, 0, 0));
    AddPoint(1, FVector(250, 100, 100));
    AddPoint(2, FVector(0, 0, 200));
    AddPoint(2, FVector(100, 100, 300));
    AddPoint(3, FVector(20, 20, 20));
    AddPoint(3, FVector(30, 30, 30));
    Tile.Pages.Add(MoveTemp(Page));

    const HaybaWorldRelations::FResult Result = HaybaWorldRelations::Build(Tile);
    TestEqual(TEXT("all sampled source nodes were evaluated"), Result.EvaluatedSourceCount, 4);
    TestFalse(TEXT("complete synthetic capture is not marked partial"), Result.bPartial);
    auto HasRelation = [&Result](const FString& Kind, const FString& Source, const FString& Target)
    {
        return Result.Relations.ContainsByPredicate([&](const HaybaWorldRelations::FRelation& Relation)
        {
            return Relation.Kind == Kind && Relation.SourceNodeId == Source &&
                Relation.TargetNodeId == Target;
        });
    };
    TestTrue(TEXT("near is a measured sampled-bounds candidate"),
        HasRelation(TEXT("near_sampled_bounds"), TEXT("/A"), TEXT("/B")));
    TestTrue(TEXT("above uses vertical separation and XY adjacency"),
        HasRelation(TEXT("above_sampled_bounds"), TEXT("/C"), TEXT("/A")));
    TestTrue(TEXT("containment is explicitly about sampled bounds"),
        HasRelation(TEXT("sampled_bounds_contains"), TEXT("/A"), TEXT("/D")));
    const HaybaWorldRelations::FResult Again = HaybaWorldRelations::Build(Tile);
    TestEqual(TEXT("relation count is deterministic"), Again.Relations.Num(), Result.Relations.Num());
    for (int32 Index = 0; Index < Result.Relations.Num(); ++Index)
        TestEqual(TEXT("relation IDs and ordering are deterministic"),
            Again.Relations[Index].Id, Result.Relations[Index].Id);
    for (const HaybaWorldRelations::FRelation& Relation : Result.Relations)
    {
        TestTrue(TEXT("relation carries exact captured point IDs"),
            !Relation.EvidencePointIds.IsEmpty() &&
            Relation.EvidencePointIds[0].StartsWith(Tile.CaptureId + TEXT("/") + Tile.TileId));
        TestTrue(TEXT("relation threshold has centimeter units"), Relation.ThresholdCm >= 0.0);
    }
    const TSharedRef<FJsonObject> FirstPage = HaybaWorldRelations::BuildPage(Result, 0, 1);
    TestEqual(TEXT("relation page honors requested limit"), FirstPage->GetArrayField(TEXT("items")).Num(), 1);
    TestEqual(TEXT("relation continuation is explicit"), FirstPage->GetNumberField(TEXT("next_offset")), 1.0);
    TestFalse(TEXT("bounds never claim line-of-sight inference"),
        FirstPage->GetBoolField(TEXT("occlusion_or_visibility_inferred")));
    TestFalse(TEXT("bounds never claim physical contact"),
        FirstPage->GetBoolField(TEXT("physical_contact_proven")));
    const TSharedRef<FJsonObject> PastEnd = HaybaWorldRelations::BuildPage(Result, MAX_int32, 1);
    TestTrue(TEXT("huge offset is clamped safely"), PastEnd->GetArrayField(TEXT("items")).IsEmpty());

    HaybaWorldRelations::FOptions SourceCapped;
    SourceCapped.MaxSources = 2;
    const HaybaWorldRelations::FResult Limited = HaybaWorldRelations::Build(Tile, SourceCapped);
    TestTrue(TEXT("source cap is disclosed"), Limited.bPartial && Limited.Gaps.Contains(TEXT("source_cap")));
    TestEqual(TEXT("source cap is enforced"), Limited.EvaluatedSourceCount, 2);
    HaybaWorldRelations::FOptions RelationCapped;
    RelationCapped.MaxRelations = 1;
    const HaybaWorldRelations::FResult One = HaybaWorldRelations::Build(Tile, RelationCapped);
    TestTrue(TEXT("relation cap is disclosed"), One.bPartial && One.Gaps.Contains(TEXT("relation_cap")));
    TestEqual(TEXT("relation cap is enforced"), One.Relations.Num(), 1);

    Tile.bPartial = true;
    Tile.Gaps.Add(TEXT("unsupported_landscape"));
    const HaybaWorldRelations::FResult Coverage = HaybaWorldRelations::Build(Tile);
    TestTrue(TEXT("tile coverage uncertainty carries into relations"),
        Coverage.bPartial && Coverage.Gaps.Contains(TEXT("unsupported_landscape")));
    return true;
}

#endif
