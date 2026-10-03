#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldGeometry.h"
#include "HaybaMCPWorldTileSnapshot.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/ScopeExit.h"
#include "UObject/UObjectGlobals.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldTileRefinementTest,
    "Hayba.MCP.World.TileRefinement",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldTileRefinementTest::RunTest(const FString& Parameters)
{
    FBox Tile(EForceInit::ForceInit);
    TestFalse(TEXT("invalid LOD fails closed"), HaybaWorldGeometry::TileBounds(3, 0, 0, 0, Tile));
    TestFalse(TEXT("unbounded tile coordinate fails closed"),
        HaybaWorldGeometry::TileBounds(1, 100001, 0, 0, Tile));
    if (!TestTrue(TEXT("fixed LOD tile bounds"),
        HaybaWorldGeometry::TileBounds(2, 120, 0, 0, Tile))) return false;
    TestEqual(TEXT("ten-meter LOD tile begins at stable grid position"), Tile.Min.X, 120000.0);
    TestEqual(TEXT("tile id is deterministic"),
        HaybaWorldGeometry::TileId(2, 120, 0, 0), FString(TEXT("tile:2:120:0:0")));
    TestTrue(TEXT("triangle bounds do not depend on vertex ordering"),
        HaybaWorldGeometry::TriangleBoundsIntersectsTile(
            FVector(120900, 900, 900), FVector(120100, 100, 100),
            FVector(120500, 500, 500), Tile));
    TestTrue(TEXT("reversed triangle bounds still intersect"),
        HaybaWorldGeometry::TriangleBoundsIntersectsTile(
            FVector(120100, 100, 100), FVector(120900, 900, 900),
            FVector(120500, 500, 500), Tile));

    FString Child;
    if (!FParse::Value(FCommandLine::Get(), TEXT("HaybaAutomationChild="), Child) ||
        Child != TEXT("p0scratch")) return true;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!TestNotNull(TEXT("scratch editor world"), World)) return false;
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (!TestNotNull(TEXT("engine cube"), Cube)) return false;
    AStaticMeshActor* Inside = World->SpawnActor<AStaticMeshActor>(
        FVector(120050, 50, 50), FRotator::ZeroRotator);
    AStaticMeshActor* Outside = World->SpawnActor<AStaticMeshActor>(
        FVector(121500, 50, 50), FRotator::ZeroRotator);
    if (!Inside || !Outside)
    {
        if (Inside) World->DestroyActor(Inside);
        if (Outside) World->DestroyActor(Outside);
        AddError(TEXT("scratch mesh actors could not be spawned"));
        return false;
    }
    ON_SCOPE_EXIT
    {
        if (IsValid(Inside)) World->DestroyActor(Inside);
        if (IsValid(Outside)) World->DestroyActor(Outside);
        HaybaWorldTileSnapshot::Invalidate();
    };
    Inside->GetStaticMeshComponent()->SetStaticMesh(Cube);
    Inside->Tags.Add(FName(TEXT("authored_tile_fixture")));
    Outside->GetStaticMeshComponent()->SetStaticMesh(Cube);
    TArray<TWeakObjectPtr<AActor>> Actors{Inside, Outside};
    HaybaWorldGeometry::FSnapshot Geometry = HaybaWorldGeometry::BuildTileBatch(
        World, Actors, Tile, 2048, 0.120);
    if (!TestTrue(TEXT("tile samples real mesh geometry"), Geometry.Splats.Num() > 256))
        return false;
    TestTrue(TEXT("tile point budget remains bounded"), Geometry.Splats.Num() <= 2048);
    TestEqual(TEXT("outside actor is excluded before source sampling"), Geometry.ActorCount, 1);
    for (const HaybaWorldGeometry::FSplat& Point : Geometry.Splats)
    {
        const FVector WorldPoint = Point.PositionCm + Geometry.OriginCm;
        TestTrue(TEXT("clipped mesh sample belongs to requested tile"), Tile.IsInsideOrOn(WorldPoint));
        TestTrue(TEXT("sample carries source node and actor"),
            Geometry.Actors.IsValidIndex(Point.ActorIndex) && Geometry.Nodes.IsValidIndex(Point.NodeIndex));
    }
    const FString FirstCaptureId = TEXT("abcdef0123456789abcdef0123456789");
    const FString SecondCaptureId = TEXT("22222222222222222222222222222222");
    const FString TileId = HaybaWorldGeometry::TileId(2, 120, 0, 0);
    HaybaWorldTileSnapshot::FTile Published;
    Published.TileId = TileId;
    Published.CaptureId = FirstCaptureId;
    Published.World = World;
    Published.WorldPath = World->GetPathName();
    Published.BoundsCm = Tile;
    Published.OriginCm = Geometry.OriginCm;
    Published.LOD = 2;
    Published.PointCount = Geometry.Splats.Num();
    HaybaWorldTileSnapshot::FPage Page;
    Page.PageId = 0;
    Page.Geometry = MoveTemp(Geometry);
    Published.Pages.Add(MoveTemp(Page));
    HaybaWorldTileSnapshot::FPage EmptyPage;
    EmptyPage.PageId = 1;
    Published.Pages.Add(MoveTemp(EmptyPage));
    HaybaWorldTileSnapshot::Publish(MoveTemp(Published));
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Captured =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId);
    if (!TestTrue(TEXT("same loaded world can query captured tile"), Captured.IsValid()))
        return false;
    const TSharedRef<FJsonObject> Summary = HaybaWorldTileSnapshot::BuildPage(
        *Captured, TEXT("summary"), 0, 0, 256);
    TestEqual(TEXT("capture provenance is explicit"), Summary->GetStringField(TEXT("capture_id")),
        FirstCaptureId);
    const TSharedRef<FJsonObject> PageList = HaybaWorldTileSnapshot::BuildPage(
        *Captured, TEXT("pages"), 0, 0, 1);
    TestEqual(TEXT("page summaries obey query limit"), PageList->GetArrayField(TEXT("items")).Num(), 1);
    TestEqual(TEXT("page continuation is explicit"), PageList->GetNumberField(TEXT("next_offset")), 1.0);
    const TSharedRef<FJsonObject> FarPage = HaybaWorldTileSnapshot::BuildPage(
        *Captured, TEXT("pages"), 0, MAX_int32, 32);
    TestEqual(TEXT("extreme page offset cannot overflow or expose rows"),
        FarPage->GetArrayField(TEXT("items")).Num(), 0);
    const TSharedRef<FJsonObject> Points = HaybaWorldTileSnapshot::BuildPage(
        *Captured, TEXT("points"), 0, 0, 1000);
    TestEqual(TEXT("read-only point page is capped"), Points->GetArrayField(TEXT("items")).Num(), 256);
    const TSharedPtr<FJsonObject> First = Points->GetArrayField(TEXT("items"))[0]->AsObject();
    TestEqual(TEXT("stable point id joins tile and page"), First->GetStringField(TEXT("id")),
        FirstCaptureId + TEXT("/tile:2:120:0:0/page:0/point:0"));
    TestEqual(TEXT("point references canonical actor source"), First->GetStringField(TEXT("actor_path")),
        Inside->GetPathName());
    TestTrue(TEXT("point references canonical node"), !First->GetStringField(TEXT("source_node_id")).IsEmpty());
    const TSharedRef<FJsonObject> Semantic = HaybaWorldTileSnapshot::BuildPage(
        *Captured, TEXT("semantic"), 0, 0, 32);
    bool bAuthoredTagFound = false;
    for (const TSharedPtr<FJsonValue>& Item : Semantic->GetArrayField(TEXT("items")))
    {
        const TSharedPtr<FJsonObject> Group = Item->AsObject();
        if (Group->GetStringField(TEXT("kind")) == TEXT("tag") &&
            Group->GetStringField(TEXT("value")) == TEXT("authored_tile_fixture"))
            bAuthoredTagFound = Group->GetNumberField(TEXT("point_count")) > 0 &&
                Group->GetStringField(TEXT("provenance")) == TEXT("authored_editor_metadata");
    }
    TestTrue(TEXT("authored tag is queryable over sampled geometry"), bAuthoredTagFound);

    HaybaWorldTileSnapshot::FTile Second;
    Second.TileId = TileId;
    Second.CaptureId = SecondCaptureId;
    Second.World = World;
    Second.OriginCm = FVector(World->OriginLocation);
    Second.BoundsCm = Tile;
    Second.LOD = 2;
    HaybaWorldTileSnapshot::Publish(MoveTemp(Second));
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> ExactFirst =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, FirstCaptureId);
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> ExactSecond =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, SecondCaptureId);
    if (!TestTrue(TEXT("older capture remains independently queryable"), ExactFirst.IsValid()) ||
        !TestTrue(TEXT("newer capture is independently queryable"), ExactSecond.IsValid())) return false;
    TestEqual(TEXT("older capture retains its original points"), ExactFirst->PointCount,
        Captured->PointCount);
    TestTrue(TEXT("wire capture IDs are case-insensitive"),
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, FirstCaptureId.ToUpper()).IsValid());
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> LatestSecond =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId);
    if (!TestTrue(TEXT("latest tile capture exists"), LatestSecond.IsValid())) return false;
    TestEqual(TEXT("latest tile lookup follows the newer capture"),
        LatestSecond->CaptureId, SecondCaptureId);
    TestFalse(TEXT("exact capture cannot be used with another tile ID"),
        HaybaWorldTileSnapshot::GetForWorld(World, TEXT("tile:2:121:0:0"), FirstCaptureId).IsValid());
    TestFalse(TEXT("unknown capture ID does not fall back to latest"),
        HaybaWorldTileSnapshot::GetForWorld(World, TileId,
            TEXT("33333333333333333333333333333333")).IsValid());

    HaybaWorldTileSnapshot::FTile Collision;
    Collision.TileId = TEXT("tile:2:121:0:0");
    Collision.CaptureId = FirstCaptureId;
    Collision.World = World;
    Collision.OriginCm = FVector(World->OriginLocation);
    HaybaWorldTileSnapshot::Publish(MoveTemp(Collision));
    TestFalse(TEXT("duplicate capture ID cannot collide with another tile"),
        HaybaWorldTileSnapshot::GetForWorld(World, TEXT("tile:2:121:0:0"), FirstCaptureId).IsValid());
    TestTrue(TEXT("collision attempt leaves original capture untouched"),
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, FirstCaptureId).IsValid());
    UWorld* DifferentWorld = NewObject<UWorld>(GetTransientPackage(), NAME_None, RF_Transient);
    TestFalse(TEXT("tile cache rejects another world"),
        HaybaWorldTileSnapshot::GetForWorld(DifferentWorld, TileId, FirstCaptureId).IsValid());
    for (int32 Index = 0; Index < 32; ++Index)
    {
        HaybaWorldTileSnapshot::FTile Extra;
        Extra.TileId = FString::Printf(TEXT("tile:test:%d"), Index);
        Extra.CaptureId = FString::Printf(TEXT("%032x"), static_cast<uint32>(Index + 16));
        Extra.World = World;
        Extra.OriginCm = FVector(World->OriginLocation);
        HaybaWorldTileSnapshot::Publish(MoveTemp(Extra));
        if (Index == 29)
        {
            TestTrue(TEXT("two same-tile captures fit within the 32-capture cache"),
                HaybaWorldTileSnapshot::GetForWorld(World, TileId, FirstCaptureId).IsValid() &&
                HaybaWorldTileSnapshot::GetForWorld(World, TileId, SecondCaptureId).IsValid());
        }
        if (Index == 30)
        {
            TestFalse(TEXT("oldest capture evicts first, independently"),
                HaybaWorldTileSnapshot::GetForWorld(World, TileId, FirstCaptureId).IsValid());
            const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Latest =
                HaybaWorldTileSnapshot::GetForWorld(World, TileId);
            TestTrue(TEXT("latest-by-tile stays on retained second capture"),
                Latest.IsValid() && Latest->CaptureId == SecondCaptureId);
        }
    }
    TestFalse(TEXT("latest lookup clears after final same-tile capture evicts"),
        HaybaWorldTileSnapshot::GetForWorld(World, TileId).IsValid());
    TestFalse(TEXT("exact lookup fails for evicted capture"),
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, SecondCaptureId).IsValid());
    TestTrue(TEXT("latest tile remains queryable"),
        HaybaWorldTileSnapshot::GetForWorld(World, TEXT("tile:test:31")).IsValid());
    HaybaWorldTileSnapshot::FTile WrongOrigin;
    WrongOrigin.TileId = TEXT("tile:test:wrong-origin");
    WrongOrigin.CaptureId = TEXT("99999999999999999999999999999999");
    WrongOrigin.World = World;
    WrongOrigin.OriginCm = FVector(World->OriginLocation) + FVector(100, 0, 0);
    HaybaWorldTileSnapshot::Publish(MoveTemp(WrongOrigin));
    TestFalse(TEXT("origin-rebased tile cannot be queried against current world"),
        HaybaWorldTileSnapshot::GetForWorld(World, TEXT("tile:test:wrong-origin"),
            TEXT("99999999999999999999999999999999")).IsValid());
    return true;
}

#endif
