#include "Misc/AutomationTest.h"
#include "HaybaMCPWorldGeometry.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/ScopeExit.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorldGeometryTest,
    "Hayba.MCP.World.MeshSurfaceGeometry",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorldGeometryTest::RunTest(const FString& Parameters)
{
    const HaybaWorldGeometry::FSnapshot Empty = HaybaWorldGeometry::Build(nullptr);
    TestEqual(TEXT("null world has no fabricated surfaces"), Empty.Splats.Num(), 0);
    TestEqual(TEXT("null world has no loaded actors"), Empty.ActorCount, 0);

    // This fixture mutates only the disposable automation child world. It is
    // intentionally inert in an interactive editor, including a user's game.
    FString Child;
    if (!FParse::Value(FCommandLine::Get(), TEXT("HaybaAutomationChild="), Child) || Child != TEXT("p0scratch")) return true;
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!TestNotNull(TEXT("scratch editor world"), World)) return false;
    UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
    if (!TestNotNull(TEXT("engine cube fixture"), Cube)) return false;

    // Exercise the previous first-400 failure: nonmesh actors precede the
    // actual geometry in this disposable scratch world.
    TArray<AActor*> NonMeshActors;
    NonMeshActors.Reserve(450);
    for (int32 Index = 0; Index < 450; ++Index)
    {
        AActor* Dummy = World->SpawnActor<AActor>(FVector(90000 + Index * 10, -10000, 0), FRotator::ZeroRotator);
        if (Dummy) NonMeshActors.Add(Dummy);
    }
    ON_SCOPE_EXIT
    {
        for (AActor* Dummy : NonMeshActors)
            if (IsValid(Dummy)) World->DestroyActor(Dummy);
    };
    if (!TestEqual(TEXT("nonmesh actors precede the mesh fixture"), NonMeshActors.Num(), 450)) return false;

    AStaticMeshActor* Single = World->SpawnActor<AStaticMeshActor>(FVector(120000, 0, 0), FRotator::ZeroRotator);
    AActor* InstancedActor = World->SpawnActor<AActor>(FVector(140000, 0, 0), FRotator::ZeroRotator);
    if (!Single || !InstancedActor)
    {
        if (Single) World->DestroyActor(Single);
        if (InstancedActor) World->DestroyActor(InstancedActor);
        AddError(TEXT("scratch geometry actors could not be spawned"));
        return false;
    }
    ON_SCOPE_EXIT
    {
        if (IsValid(Single)) World->DestroyActor(Single);
        if (IsValid(InstancedActor)) World->DestroyActor(InstancedActor);
    };
    Single->GetStaticMeshComponent()->SetStaticMesh(Cube);
    Single->SetFolderPath(FName(TEXT("Semantic/Market")));
    Single->Tags.AddUnique(FName(TEXT("authored_hero")));
    Single->GetStaticMeshComponent()->ComponentTags.AddUnique(FName(TEXT("authored_shell")));
    UStaticMeshComponent* MissingMesh = NewObject<UStaticMeshComponent>(Single, NAME_None, RF_Transient);
    MissingMesh->RegisterComponent();
    InstancedActor->SetFolderPath(FName(TEXT("Semantic/Market")));
    UInstancedStaticMeshComponent* Instances = NewObject<UInstancedStaticMeshComponent>(InstancedActor, NAME_None, RF_Transient);
    InstancedActor->SetRootComponent(Instances);
    Instances->SetStaticMesh(Cube);
    Instances->RegisterComponent();
    Instances->AddInstance(FTransform(FVector(0, 0, 0)));
    Instances->AddInstance(FTransform(FVector(1200, 0, 0)));

    const HaybaWorldGeometry::FSnapshot Geometry = HaybaWorldGeometry::Build(World);
    AddInfo(FString::Printf(TEXT("World coverage: visited=%d eligibleMesh=%d selected=%d processed=%d elapsed=%.2fms stop=%s"),
        Geometry.VisitedActorCount, Geometry.EligibleMeshActorCount, Geometry.SelectedActorCount,
        Geometry.ActorCount, Geometry.ElapsedMs, *Geometry.StopReason));
    TestTrue(TEXT("surface samples are bounded"), Geometry.Splats.Num() <= 4096);
    TestTrue(TEXT("source instances are bounded"), Geometry.InstanceCount <= 1024);
    TestTrue(TEXT("actors are bounded"), Geometry.ActorCount <= 400);
    TestTrue(TEXT("nonmesh actors do not consume geometry selection"), Geometry.VisitedActorCount >= 452 && Geometry.ActorCount < 400);
    TestTrue(TEXT("scan reports its actual elapsed time"), Geometry.ElapsedMs > 0.0);
    TestTrue(TEXT("observed instances are distinct from sampled transforms"),
        Geometry.ObservedInstanceCount > Geometry.InstanceCount);
    const int32* CpuUnavailable = Geometry.UnsupportedByKind.Find(TEXT("cpu_lod_unavailable"));
    if (CpuUnavailable && *CpuUnavailable > 0 && Geometry.Splats.IsEmpty())
    {
        AddError(TEXT("scratch engine cube has no CPU render LOD; surface fixture cannot run"));
        return false;
    }
    int32 SingleIndex = INDEX_NONE, InstancesIndex = INDEX_NONE;
    for (int32 Index = 0; Index < Geometry.Actors.Num(); ++Index)
    {
        if (Geometry.Actors[Index].LoadedActor.Get() == Single) SingleIndex = Index;
        if (Geometry.Actors[Index].LoadedActor.Get() == InstancedActor) InstancesIndex = Index;
    }
    if (!TestTrue(TEXT("both loaded fixture actors were scanned"), SingleIndex >= 0 && InstancesIndex >= 0)) return false;
    if (!TestTrue(TEXT("late geometry produced surface points"), !Geometry.Splats.IsEmpty())) return false;
    bool bSingleSurface = false, bFirstInstance = false, bSecondInstance = false;
    bool bFirstInstanceNode = false, bSecondInstanceNode = false;
    bool bActorTag = false, bComponentTag = false, bLevelNode = false, bFolderNode = false, bMetadataOnlyComponent = false;
    for (const HaybaWorldGeometry::FNode& Node : Geometry.Nodes)
    {
        bActorTag |= Node.Kind == TEXT("actor") && Node.ActorIndex == SingleIndex && Node.Tags.Contains(TEXT("authored_hero"));
        bComponentTag |= Node.Kind == TEXT("component") && Node.ActorIndex == SingleIndex && Node.Tags.Contains(TEXT("authored_shell")) && Node.MeshAsset == Cube->GetPathName();
        bLevelNode |= Node.Kind == TEXT("level") && Node.ParentIndex == 0;
        bFolderNode |= Node.Kind == TEXT("folder") && Node.Folder == TEXT("Semantic/Market");
        bFirstInstanceNode |= Node.Kind == TEXT("instance") && Node.ActorIndex == InstancesIndex && Node.InstanceIndex == 0;
        bSecondInstanceNode |= Node.Kind == TEXT("instance") && Node.ActorIndex == InstancesIndex && Node.InstanceIndex == 1;
        bMetadataOnlyComponent |= Node.Path == MissingMesh->GetPathName() &&
            Node.GeometryStatus == TEXT("missing_render_lod") && Node.SourceCount == 0 && Node.SplatCount == 0;
    }
    TestTrue(TEXT("authored actor tag is preserved as a fact"), bActorTag);
    TestTrue(TEXT("authored component tag and mesh path are preserved"), bComponentTag);
    TestTrue(TEXT("real level is represented in source hierarchy"), bLevelNode);
    TestTrue(TEXT("nested authored folder is represented"), bFolderNode);
    TestTrue(TEXT("both instance identities are represented"), bFirstInstanceNode && bSecondInstanceNode);
    TestTrue(TEXT("unsupported component remains in authored tree without claiming samples"), bMetadataOnlyComponent);
    TestTrue(TEXT("spatial root exists only when surfaces were sampled"), Geometry.Clusters.Num() > 1 && Geometry.Clusters[0].Id == TEXT("spatial:root"));
    TestTrue(TEXT("spatial clusters are bounded"), Geometry.Clusters.Num() <= 73);
    bool bTaggedFineCluster = false;
    for (const HaybaWorldGeometry::FCluster& Cluster : Geometry.Clusters)
    {
        bTaggedFineCluster |= Cluster.Level == 2 && Cluster.ActorIndices.Contains(SingleIndex) &&
            Cluster.Tags.Contains(TEXT("authored_hero")) && Cluster.Tags.Contains(TEXT("authored_shell"));
    }
    TestTrue(TEXT("derived clusters retain authored source tags"), bTaggedFineCluster);
    TestTrue(TEXT("structural root summarizes sampled sources"),
        !Geometry.Nodes.IsEmpty() && Geometry.Nodes[0].SourceCount >= 3 &&
        Geometry.Nodes[0].SplatCount == Geometry.Splats.Num());
    TestTrue(TEXT("spatial root summarizes sampled splats"),
        !Geometry.Clusters.IsEmpty() && Geometry.Clusters[0].SplatCount == Geometry.Splats.Num());
    int32 VerifiedReferences = 0;
    int32 FaceSamples = 0;
    double FaceMinY = TNumericLimits<double>::Max(), FaceMaxY = -TNumericLimits<double>::Max();
    double FaceMinZ = TNumericLimits<double>::Max(), FaceMaxZ = -TNumericLimits<double>::Max();
    for (const HaybaWorldGeometry::FSplat& S : Geometry.Splats)
    {
        const FVector WorldPoint = S.PositionCm + Geometry.OriginCm;
        if (Geometry.Nodes.IsValidIndex(S.NodeIndex) && Geometry.Clusters.IsValidIndex(S.ClusterIndex) &&
            Geometry.Nodes[S.NodeIndex].ActorIndex == S.ActorIndex &&
            Geometry.Clusters[S.ClusterIndex].Level == 2 &&
            Geometry.Clusters[S.ClusterIndex].BoundsCm.IsInsideOrOn(WorldPoint))
        {
            int32 Depth = 0;
            for (int32 At = S.NodeIndex; Geometry.Nodes.IsValidIndex(At) && Depth <= Geometry.Nodes.Num(); At = Geometry.Nodes[At].ParentIndex) ++Depth;
            if (Depth >= 4 && Depth <= Geometry.Nodes.Num()) ++VerifiedReferences;
        }
        if (S.ActorIndex == SingleIndex)
        {
            const double Distance = FVector::Distance(WorldPoint, Single->GetActorLocation());
            bSingleSurface |= Distance > 25.0 && Distance < 90.0 && S.Normal.IsNormalized();
            if (FMath::Abs(WorldPoint.X - Single->GetActorLocation().X - 50.0) < 1.0 && FMath::Abs(S.Normal.X) > 0.9)
            {
                ++FaceSamples;
                FaceMinY = FMath::Min(FaceMinY, WorldPoint.Y);
                FaceMaxY = FMath::Max(FaceMaxY, WorldPoint.Y);
                FaceMinZ = FMath::Min(FaceMinZ, WorldPoint.Z);
                FaceMaxZ = FMath::Max(FaceMaxZ, WorldPoint.Z);
            }
        }
        if (S.ActorIndex == InstancesIndex)
        {
            bFirstInstance |= FVector::Distance(WorldPoint, InstancedActor->GetActorLocation()) < 100.0;
            bSecondInstance |= FVector::Distance(WorldPoint, InstancedActor->GetActorLocation() + FVector(1200, 0, 0)) < 100.0;
        }
    }
    TestTrue(TEXT("static mesh points lie on transformed triangle surfaces, not actor origin"), bSingleSurface);
    TestTrue(TEXT("one cube face receives many distributed samples"),
        FaceSamples >= 8 && FaceMaxY - FaceMinY > 30.0 && FaceMaxZ - FaceMinZ > 30.0);
    TestTrue(TEXT("first instanced mesh surface is represented"), bFirstInstance);
    TestTrue(TEXT("second instanced mesh surface is represented"), bSecondInstance);
    TestEqual(TEXT("every point references real source ancestry and a derived fine cluster"), VerifiedReferences, Geometry.Splats.Num());
    const TSharedRef<FJsonObject> Compact = HaybaWorldGeometry::ToMetadataJson(Geometry);
    const TSharedRef<FJsonObject> Expanded = HaybaWorldGeometry::ToMetadataJson(Geometry, true);
    TestFalse(TEXT("default machine-readable snapshot does not flood point positions"), Compact->HasField(TEXT("splats")));
    TestTrue(TEXT("focused opt-in can include point positions"), Expanded->HasField(TEXT("splats")));
    const TSharedPtr<FJsonObject> Coverage = Compact->GetObjectField(TEXT("coverage"));
    TestEqual(TEXT("spatial grouping is labeled derived"), Coverage->GetStringField(TEXT("clusterProvenance")), FString(TEXT("derived_spatial")));
    TestTrue(TEXT("coverage declares sampled and observed instance counts"),
        Coverage->GetNumberField(TEXT("observedInstanceCount")) > Coverage->GetNumberField(TEXT("sampledInstanceCount")));
    TestTrue(TEXT("coverage declares visited actors and partial-scan state"),
        Coverage->GetNumberField(TEXT("visitedActorCount")) >= 452 && Coverage->HasField(TEXT("actorIteratorComplete")) &&
        Coverage->HasField(TEXT("stopReason")) && Coverage->GetNumberField(TEXT("elapsedMs")) > 0.0);
    const TSharedRef<FJsonObject> NodePage = HaybaWorldGeometry::ToMetadataJson(Geometry, false, TEXT("nodes"), 0, 2);
    TestEqual(TEXT("paged metadata only emits requested nodes"), NodePage->GetArrayField(TEXT("nodes")).Num(), 2);
    TestFalse(TEXT("paged metadata omits unrelated actors"), NodePage->HasField(TEXT("actors")));
    TestEqual(TEXT("single point encoder preserves 12-field wire row"),
        HaybaWorldGeometry::SplatToJson(Geometry.Splats[0])->AsArray().Num(), 12);
    const TArray<TSharedPtr<FJsonValue>>& ClusterJson = Compact->GetArrayField(TEXT("clusters"));
    if (TestTrue(TEXT("machine-readable cluster summaries are available"), !ClusterJson.IsEmpty()))
    {
        const TSharedPtr<FJsonObject> RootCluster = ClusterJson[0]->AsObject();
        TestEqual(TEXT("cluster tags identify their factual source"),
            RootCluster->GetStringField(TEXT("tagsProvenance")), FString(TEXT("union_of_source_editor_tags")));
        TestTrue(TEXT("cluster tag cap is disclosed"), RootCluster->HasField(TEXT("tagsTruncated")));
    }
    // A panel scan advances over many small loaded-actor slices. This fixture
    // proves their real triangle samples can exceed the old whole-world 4k cap
    // while each editor-frame slice stays bounded and keeps local source links.
    TArray<AStaticMeshActor*> DenseActors;
    for (int32 Index = 0; Index < 96; ++Index)
    {
        AStaticMeshActor* Item = World->SpawnActor<AStaticMeshActor>(
            FVector(200000 + (Index % 16) * 180, (Index / 16) * 180, 0), FRotator::ZeroRotator);
        if (!Item) break;
        Item->GetStaticMeshComponent()->SetStaticMesh(Cube);
        Item->SetFolderPath(FName(TEXT("Dense/Block")));
        DenseActors.Add(Item);
    }
    ON_SCOPE_EXIT
    {
        for (AStaticMeshActor* Item : DenseActors)
            if (IsValid(Item)) World->DestroyActor(Item);
    };
    if (!TestEqual(TEXT("dense batch fixture actors"), DenseActors.Num(), 96)) return false;
    int32 DensePoints = 0;
    for (int32 Start = 0; Start < DenseActors.Num(); Start += 8)
    {
        TArray<TWeakObjectPtr<AActor>> Page;
        for (int32 At = Start; At < Start + 8; ++At) Page.Add(DenseActors[At]);
        const HaybaWorldGeometry::FSnapshot Slice = HaybaWorldGeometry::BuildBatch(World, Page, 512, 0.120);
        TestEqual(TEXT("every loaded page actor is processed"), Slice.ActorCount, 8);
        TestTrue(TEXT("page point budget is respected"), Slice.Splats.Num() <= 512);
        for (const HaybaWorldGeometry::FSplat& Point : Slice.Splats)
            TestTrue(TEXT("dense point retains source actor and node"),
                Slice.Actors.IsValidIndex(Point.ActorIndex) && Slice.Nodes.IsValidIndex(Point.NodeIndex));
        DensePoints += Slice.Splats.Num();
    }
    TestTrue(TEXT("dense scan exceeds old whole-world point cap"), DensePoints > 4096);
    return true;
}

#endif
