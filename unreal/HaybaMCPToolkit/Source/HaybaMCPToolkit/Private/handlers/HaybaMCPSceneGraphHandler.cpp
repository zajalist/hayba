#include "HaybaMCPSceneGraphHandler.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPWorldGeometry.h"
#include "HaybaMCPViewDepthSnapshot.h"
#include "HaybaMCPWorldTileSnapshot.h"
#include "HaybaMCPWorldTileCapture.h"
#include "HaybaMCPWorldRelations.h"
#include "HaybaMCPWorldQuery.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Engine/World.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/DateTime.h"
#include "CollisionQueryParams.h"
#include "Engine/OverlapResult.h"
#include "Engine/Light.h"
#include "Engine/SkyLight.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Engine/SceneCapture.h"
#include "Landscape.h"
#include "LandscapeStreamingProxy.h"
#include "Engine/Brush.h"

// Classes that don't represent physical objects standing on the ground —
// flagging them as "floating" or "interpenetrating" generates pure noise.
// Keep this list narrow: only classes that are by-design non-physical or
// always pseudo-positioned (lights, atmosphere, world systems, landscape).
static bool ShouldSkipPhysicsCheck(AActor* A)
{
    if (!A) return true;
    if (A->IsA(ALight::StaticClass())) return true;
    if (A->IsA(ASkyLight::StaticClass())) return true;
    if (A->FindComponentByClass<USkyAtmosphereComponent>()) return true;
    if (A->FindComponentByClass<UVolumetricCloudComponent>()) return true;
    if (A->FindComponentByClass<UExponentialHeightFogComponent>()) return true;
    if (A->IsA(ASceneCapture::StaticClass())) return true;
    if (A->IsA(ALandscape::StaticClass())) return true;
    if (A->IsA(ALandscapeStreamingProxy::StaticClass())) return true;
    if (A->IsA(ABrush::StaticClass())) return true;
    // Class-name fallback for engine-internal types we don't want to link
    // headers for (WorldSettings, WorldDataLayers, MassVisualizer, …).
    const FString ClassName = A->GetClass()->GetName();
    if (ClassName == TEXT("WorldSettings")) return true;
    if (ClassName == TEXT("WorldDataLayers")) return true;
    if (ClassName == TEXT("WorldPartitionMiniMap")) return true;
    if (ClassName == TEXT("MassVisualizer")) return true;
    if (ClassName == TEXT("DefaultPhysicsVolume")) return true;
    if (ClassName == TEXT("GameplayDebuggerPlayerManager")) return true;
    if (ClassName == TEXT("PlayerStart")) return true;
    if (ClassName.StartsWith(TEXT("Chaos"))) return true;
    // World Partition HLOD instancing actors — generated, not authored geometry.
    if (ClassName.StartsWith(TEXT("WorldPartitionHLOD"))) return true;
    if (ClassName.StartsWith(TEXT("HLOD"))) return true;
    // Subsystem / debug rendering actors are pseudo-positioned.
    if (ClassName.EndsWith(TEXT("RenderingActor"))) return true;
    if (ClassName.EndsWith(TEXT("SubsystemRenderingActor"))) return true;
    // Actor-label fallback for HLOD instancing (class is HLODInstancedStaticMeshActor or similar generated name).
    const FString Label = A->GetName();
    if (Label.StartsWith(TEXT("HLOD"))) return true;
    return false;
}

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPScene, Log, All);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

TArray<FString> FHaybaMCPSceneGraphHandler::GetCommands() const
{
    return {
        TEXT("scene_export"),
        TEXT("world_semantic_snapshot"),
        TEXT("world_tile_capture"),
        TEXT("world_query"),
        TEXT("scene_validate_physics"),
        TEXT("scene_get_actor_relations"),
    };
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("scene_export"))              return Export(Params);
    if (Cmd == TEXT("world_semantic_snapshot"))   return WorldSemanticSnapshot(Params);
    if (Cmd == TEXT("world_tile_capture"))        return WorldTileCapture(Params);
    if (Cmd == TEXT("world_query"))               return WorldQuery(Params);
    if (Cmd == TEXT("scene_validate_physics"))    return ValidatePhysics(Params);
    if (Cmd == TEXT("scene_get_actor_relations")) return GetActorRelations(Params);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("SceneGraphHandler: unknown command %s"), *Cmd));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

FHaybaMCPSceneGraphHandler::EMode FHaybaMCPSceneGraphHandler::ParseMode(const FString& S)
{
    if (S == TEXT("relational"))  return EMode::Relational;
    if (S == TEXT("hierarchical")) return EMode::Hierarchical;
    return EMode::Flat;
}

FBox FHaybaMCPSceneGraphHandler::ParseWindow(const TSharedPtr<FJsonObject>& P)
{
    const TSharedPtr<FJsonObject>* WinObj;
    if (!P->TryGetObjectField(TEXT("window"), WinObj) || !WinObj->IsValid())
        return FBox(ForceInit);

    const TArray<TSharedPtr<FJsonValue>>* MinArr;
    const TArray<TSharedPtr<FJsonValue>>* MaxArr;
    if (!(*WinObj)->TryGetArrayField(TEXT("min"), MinArr) || MinArr->Num() < 3)
        return FBox(ForceInit);
    if (!(*WinObj)->TryGetArrayField(TEXT("max"), MaxArr) || MaxArr->Num() < 3)
        return FBox(ForceInit);

    FVector MinV((*MinArr)[0]->AsNumber(), (*MinArr)[1]->AsNumber(), (*MinArr)[2]->AsNumber());
    FVector MaxV((*MaxArr)[0]->AsNumber(), (*MaxArr)[1]->AsNumber(), (*MaxArr)[2]->AsNumber());
    return FBox(MinV, MaxV);
}

TArray<AActor*> FHaybaMCPSceneGraphHandler::CollectInWindow(UWorld* W, const FBox& Box, int32 MaxItems)
{
    TArray<AActor*> Result;
    if (!W) return Result;

    for (TActorIterator<AActor> It(W); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        if (A->ActorHasTag(TEXT("HaybaMCPCaptureActor"))) continue;
        if (Box.IsValid && !Box.IsInsideOrOn(A->GetActorLocation())) continue;
        Result.Add(A);
        if (Result.Num() >= MaxItems) break;
    }
    return Result;
}

TSharedRef<FJsonObject> FHaybaMCPSceneGraphHandler::ActorToFlatJson(AActor* A)
{
    TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
    Obj->SetStringField(TEXT("id"),    A->GetName());
    Obj->SetStringField(TEXT("label"), A->GetActorLabel());
    Obj->SetStringField(TEXT("class"), A->GetClass()->GetName());

    FVector Loc = A->GetActorLocation();
    TArray<TSharedPtr<FJsonValue>> LocArr = {
        MakeShared<FJsonValueNumber>(Loc.X),
        MakeShared<FJsonValueNumber>(Loc.Y),
        MakeShared<FJsonValueNumber>(Loc.Z),
    };
    Obj->SetArrayField(TEXT("location"), LocArr);

    FRotator Rot = A->GetActorRotation();
    TArray<TSharedPtr<FJsonValue>> RotArr = {
        MakeShared<FJsonValueNumber>(Rot.Pitch),
        MakeShared<FJsonValueNumber>(Rot.Yaw),
        MakeShared<FJsonValueNumber>(Rot.Roll),
    };
    Obj->SetArrayField(TEXT("rotation"), RotArr);

    FBox Bounds = A->GetComponentsBoundingBox(true);
    FVector Extent = Bounds.GetExtent();
    TArray<TSharedPtr<FJsonValue>> ExtArr = {
        MakeShared<FJsonValueNumber>(Extent.X),
        MakeShared<FJsonValueNumber>(Extent.Y),
        MakeShared<FJsonValueNumber>(Extent.Z),
    };
    Obj->SetArrayField(TEXT("bounds_extent"), ExtArr);

    return Obj;
}

FString FHaybaMCPSceneGraphHandler::ClassifyActor(AActor* A)
{
    FString ClassName = A->GetClass()->GetName();
    if (ClassName.StartsWith(TEXT("BP_Tree"))    || ClassName.StartsWith(TEXT("SM_Tree")) ||
        ClassName.StartsWith(TEXT("SM_Foliage")))
        return TEXT("vegetation");
    if (ClassName.StartsWith(TEXT("SM_Building")) || ClassName.StartsWith(TEXT("BP_Building")) ||
        ClassName.StartsWith(TEXT("BP_House")))
        return TEXT("structure");
    if (ClassName.StartsWith(TEXT("BP_NPC"))     || ClassName.StartsWith(TEXT("BP_Character")) ||
        ClassName.StartsWith(TEXT("BP_Enemy")))
        return TEXT("character");
    if (ClassName.StartsWith(TEXT("BP_Light"))   || ClassName.StartsWith(TEXT("PointLight")) ||
        ClassName.StartsWith(TEXT("SpotLight"))  || ClassName.StartsWith(TEXT("DirectionalLight")))
        return TEXT("lighting");
    if (ClassName.StartsWith(TEXT("BP_VFX"))     || ClassName.StartsWith(TEXT("NiagaraActor")))
        return TEXT("vfx");
    return TEXT("misc");
}

void FHaybaMCPSceneGraphHandler::WriteCognitiveMapCache(const TSharedRef<FJsonObject>& Data)
{
    // Build a local copy so we don't mutate the caller's object
    TSharedRef<FJsonObject> CacheObj = MakeShared<FJsonObject>();
    for (const auto& Field : Data->Values)
        CacheObj->SetField(FString(*Field.Key), Field.Value);

    // Add timestamp only to the local copy
    CacheObj->SetStringField(TEXT("built_at"), FDateTime::UtcNow().ToIso8601());

    FString JsonStr;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&JsonStr);
    FJsonSerializer::Serialize(CacheObj, Writer);

    FString CachePath = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("hayba-cognitive-map.json"));
    FFileHelper::SaveStringToFile(JsonStr, *CachePath);
}

// ---------------------------------------------------------------------------
// BuildFlat
// ---------------------------------------------------------------------------

TSharedRef<FJsonObject> FHaybaMCPSceneGraphHandler::BuildFlat(const TArray<AActor*>& Actors)
{
    TArray<TSharedPtr<FJsonValue>> ActorArr;
    for (AActor* A : Actors)
        ActorArr.Add(MakeShared<FJsonValueObject>(ActorToFlatJson(A)));

    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("mode"), TEXT("flat"));
    Out->SetArrayField(TEXT("actors"), ActorArr);
    Out->SetNumberField(TEXT("count"), ActorArr.Num());
    return Out;
}

// ---------------------------------------------------------------------------
// BuildRelational
// ---------------------------------------------------------------------------

TSharedRef<FJsonObject> FHaybaMCPSceneGraphHandler::BuildRelational(const TArray<AActor*>& Actors)
{
    TArray<TSharedPtr<FJsonValue>> Relations;

    for (int32 i = 0; i < Actors.Num(); ++i)
    {
        AActor* A = Actors[i];
        FVector LocA = A->GetActorLocation();

        // Find k=5 nearest
        TArray<TPair<float, AActor*>> Distances;
        for (int32 j = 0; j < Actors.Num(); ++j)
        {
            if (i == j) continue;
            float Dist = FVector::Dist(LocA, Actors[j]->GetActorLocation());
            Distances.Add(TPair<float, AActor*>(Dist, Actors[j]));
        }
        Distances.Sort([](const TPair<float, AActor*>& A, const TPair<float, AActor*>& B) {
            return A.Key < B.Key;
        });

        int32 K = FMath::Min(5, Distances.Num());
        for (int32 k = 0; k < K; ++k)
        {
            float Dist = Distances[k].Key;
            AActor* B  = Distances[k].Value;

            FString Relation;
            if (Dist < 200.f)       Relation = TEXT("adjacent_to");
            else if (Dist < 2000.f) Relation = TEXT("near");
            else                    continue; // skip "far"

            TSharedRef<FJsonObject> Rel = MakeShared<FJsonObject>();
            Rel->SetStringField(TEXT("from_id"),  A->GetName());
            Rel->SetStringField(TEXT("to_id"),    B->GetName());
            Rel->SetStringField(TEXT("relation"), Relation);
            Rel->SetNumberField(TEXT("distance"), Dist);
            Relations.Add(MakeShared<FJsonValueObject>(Rel));
        }
    }

    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("mode"), TEXT("relational"));
    Out->SetArrayField(TEXT("relations"), Relations);
    Out->SetNumberField(TEXT("actor_count"), Actors.Num());
    return Out;
}

// ---------------------------------------------------------------------------
// BuildHierarchical
// ---------------------------------------------------------------------------

TSharedRef<FJsonObject> FHaybaMCPSceneGraphHandler::BuildHierarchical(const TArray<AActor*>& Actors)
{
    TMap<FString, TArray<TSharedPtr<FJsonValue>>> Groups;

    for (AActor* A : Actors)
    {
        FString Category = ClassifyActor(A);
        Groups.FindOrAdd(Category).Add(MakeShared<FJsonValueObject>(ActorToFlatJson(A)));
    }

    TSharedRef<FJsonObject> GroupsObj = MakeShared<FJsonObject>();
    for (auto& Pair : Groups)
        GroupsObj->SetArrayField(Pair.Key, Pair.Value);

    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("mode"), TEXT("hierarchical"));
    Out->SetObjectField(TEXT("groups"), GroupsObj);
    return Out;
}

// ---------------------------------------------------------------------------
// scene_export
// ---------------------------------------------------------------------------

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::Export(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("scene_export: no editor world"));

    FString ModeStr = TEXT("flat");
    P->TryGetStringField(TEXT("mode"), ModeStr);
    EMode Mode = ParseMode(ModeStr);

    double MaxItemsDbl = 200.0;
    P->TryGetNumberField(TEXT("max_items"), MaxItemsDbl);
    int32 MaxItems = FMath::Max(1, (int32)MaxItemsDbl);

    FBox Window = ParseWindow(P);
    TArray<AActor*> Actors = CollectInWindow(World, Window, MaxItems);

    TSharedRef<FJsonObject> Result =
        (Mode == EMode::Relational)   ? BuildRelational(Actors)   :
        (Mode == EMode::Hierarchical) ? BuildHierarchical(Actors) :
                                        BuildFlat(Actors);

    WriteCognitiveMapCache(Result);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::WorldSemanticSnapshot(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid())
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: parameters must be an object"));
    FString Source = TEXT("mesh");
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("source"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: source must be a string"));
    P->TryGetStringField(TEXT("source"), Source);
    if (Source != TEXT("mesh") && Source != TEXT("view_depth") && Source != TEXT("mesh_tile"))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: unknown source"));
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (Source == TEXT("view_depth")) return ViewDepthSnapshot(P, World);
    if (Source == TEXT("mesh_tile")) return WorldTileSnapshot(P, World);
    if (P->HasField(TEXT("expected_capture_id")) || P->HasField(TEXT("group_id")) ||
        P->HasField(TEXT("tile_id")) || P->HasField(TEXT("page_id")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: capture filter requires source view_depth or mesh_tile"));
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: no editor world"));

    FString Section = TEXT("overview");
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("section"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: section must be a string"));
    P->TryGetStringField(TEXT("section"), Section);
    if (Section != TEXT("overview") && Section != TEXT("actors") &&
        Section != TEXT("nodes") && Section != TEXT("clusters") &&
        Section != TEXT("members") && Section != TEXT("splats"))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: unknown section"));

    auto ReadIndex = [&P](const TCHAR* Name, int32 Default, int32 Max, int32& Out)
    {
        Out = Default;
        const TSharedPtr<FJsonValue>* Value = P->Values.Find(Name);
        if (!Value) return true;
        if (!Value->IsValid() || (*Value)->Type != EJson::Number) return false;
        const double Number = (*Value)->AsNumber();
        if (!FMath::IsFinite(Number) || Number < 0.0 || Number > Max || FMath::FloorToDouble(Number) != Number) return false;
        Out = static_cast<int32>(Number);
        return true;
    };
    int32 Offset = 0, Limit = 32, ClusterIndex = INDEX_NONE, NodeIndex = INDEX_NONE;
    if (!ReadIndex(TEXT("offset"), 0, 100000, Offset) ||
        !ReadIndex(TEXT("limit"), 32, 32, Limit) || Limit == 0 ||
        !ReadIndex(TEXT("cluster_index"), INDEX_NONE, 100000, ClusterIndex) ||
        !ReadIndex(TEXT("node_index"), INDEX_NONE, 100000, NodeIndex))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid pagination or index"));

    FString MemberKind = TEXT("nodes");
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("member_kind"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: member_kind must be a string"));
    P->TryGetStringField(TEXT("member_kind"), MemberKind);
    if (MemberKind != TEXT("nodes") && MemberKind != TEXT("actors"))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: member_kind must be nodes or actors"));
    if ((ClusterIndex != INDEX_NONE && Section != TEXT("members") && Section != TEXT("splats")) ||
        (NodeIndex != INDEX_NONE && Section != TEXT("splats")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: filter does not apply to this section"));

    const HaybaWorldGeometry::FSnapshot Snapshot = HaybaWorldGeometry::Build(World);
    if ((ClusterIndex != INDEX_NONE && !Snapshot.Clusters.IsValidIndex(ClusterIndex)) ||
        (NodeIndex != INDEX_NONE && !Snapshot.Nodes.IsValidIndex(NodeIndex)) ||
        (Section == TEXT("members") && ClusterIndex == INDEX_NONE))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: index outside current scan"));

    // Page indices belong to one scan. Hash the metadata and sampled positions
    // relevant to pagination so callers can detect a changed scene view.
    uint32 Fingerprint = GetTypeHash(World->GetPathName());
    auto Mix = [&Fingerprint](const auto& Value)
    {
        Fingerprint = HashCombineFast(Fingerprint, GetTypeHash(Value));
    };
    auto MixVector = [&Mix](const FVector& Value)
    {
        Mix(Value.X);
        Mix(Value.Y);
        Mix(Value.Z);
    };
    Mix(Snapshot.ActorCount);
    Mix(Snapshot.VisitedActorCount);
    Mix(Snapshot.EligibleMeshActorCount);
    Mix(Snapshot.EligibleMetadataActorCount);
    Mix(Snapshot.SelectedActorCount);
    Mix(Snapshot.EligibilityComponentCount);
    Mix(Snapshot.ComponentCount);
    Mix(Snapshot.ObservedInstanceCount);
    Mix(Snapshot.bObservedInstanceCountSaturated);
    Mix(Snapshot.InstanceCount);
    Mix(Snapshot.ClusteredSplatCount);
    Mix(Snapshot.bActorIteratorComplete);
    Mix(Snapshot.bClusterPartial);
    Mix(Snapshot.bTruncated);
    Mix(Snapshot.bDownsampled);
    Mix(Snapshot.bNaniteProxy);
    Mix(Snapshot.StopReason);
    for (const FString& Reason : Snapshot.StopReasons) Mix(Reason);
    TArray<FString> UnsupportedKinds;
    Snapshot.UnsupportedByKind.GetKeys(UnsupportedKinds);
    UnsupportedKinds.Sort();
    for (const FString& Kind : UnsupportedKinds)
    {
        Mix(Kind);
        Mix(Snapshot.UnsupportedByKind.FindChecked(Kind));
    }
    MixVector(Snapshot.OriginCm);
    MixVector(Snapshot.BoundsCm.Min);
    MixVector(Snapshot.BoundsCm.Max);
    for (const HaybaWorldGeometry::FActor& Actor : Snapshot.Actors)
    {
        Mix(Actor.Path);
        Mix(Actor.Label);
        Mix(Actor.Folder);
    }
    for (const HaybaWorldGeometry::FNode& Node : Snapshot.Nodes)
    {
        Mix(Node.Id);
        Mix(Node.Label);
        Mix(Node.ParentIndex);
        Mix(Node.Kind);
        Mix(Node.Path);
        Mix(Node.Level);
        Mix(Node.Folder);
        Mix(Node.ActorClass);
        Mix(Node.MeshAsset);
        Mix(Node.GeometryStatus);
        Mix(Node.ActorIndex);
        Mix(Node.InstanceIndex);
        Mix(Node.ObservedInstanceCount);
        Mix(Node.SourceCount);
        Mix(Node.SplatCount);
        Mix(Node.bTagsTruncated);
        MixVector(Node.BoundsCm.Min);
        MixVector(Node.BoundsCm.Max);
        for (const FString& Tag : Node.Tags)
            Mix(Tag);
    }
    for (const HaybaWorldGeometry::FCluster& Cluster : Snapshot.Clusters)
    {
        Mix(Cluster.Id);
        Mix(Cluster.ParentIndex);
        Mix(Cluster.Level);
        Mix(Cluster.SplatCount);
        Mix(Cluster.RadiusCm);
        Mix(Cluster.bTagsTruncated);
        MixVector(Cluster.CentroidCm);
        MixVector(Cluster.BoundsCm.Min);
        MixVector(Cluster.BoundsCm.Max);
        for (int32 Index : Cluster.ActorIndices) Mix(Index);
        for (int32 Index : Cluster.NodeIndices) Mix(Index);
        for (const FString& Tag : Cluster.Tags)
            Mix(Tag);
    }
    for (const HaybaWorldGeometry::FSplat& Splat : Snapshot.Splats)
    {
        MixVector(Splat.PositionCm);
        MixVector(Splat.Normal);
        Mix(Splat.R);
        Mix(Splat.G);
        Mix(Splat.B);
        Mix(Splat.ActorIndex);
        Mix(Splat.NodeIndex);
        Mix(Splat.ClusterIndex);
    }
    const FString ScanId = FString::Printf(TEXT("%08X"), Fingerprint);
    FString ExpectedScanId;
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("expected_scan_id"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: expected_scan_id must be a string"));
    if (P->TryGetStringField(TEXT("expected_scan_id"), ExpectedScanId))
    {
        if (ExpectedScanId.Len() != 8)
            return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_scan_id"));
        for (int32 Index = 0; Index < ExpectedScanId.Len(); ++Index)
        {
            const TCHAR Digit = ExpectedScanId[Index];
            if (!((Digit >= TEXT('0') && Digit <= TEXT('9')) ||
                (Digit >= TEXT('A') && Digit <= TEXT('F')) ||
                (Digit >= TEXT('a') && Digit <= TEXT('f'))))
                return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_scan_id"));
        }
        if (!ExpectedScanId.Equals(ScanId, ESearchCase::IgnoreCase))
            return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: scan changed; restart pagination"));
    }

    // Keep page reads proportional to the returned records. The geometry scan
    // itself is bounded; building every point's JSON for a 32-item read would
    // defeat that bound on a busy editor frame.
    const TSharedRef<FJsonObject> Summary = HaybaWorldGeometry::ToMetadataJson(
        Snapshot, false, TEXT("overview"));
    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("scan_id"), ScanId);
    Out->SetStringField(TEXT("source"), TEXT("mesh"));
    Out->SetStringField(TEXT("section"), Section);
    Out->SetNumberField(TEXT("offset"), Offset);
    Out->SetNumberField(TEXT("limit"), Limit);
    Out->SetBoolField(TEXT("indices_scan_local"), true);
    Out->SetObjectField(TEXT("coverage"), Summary->GetObjectField(TEXT("coverage")).ToSharedRef());
    Out->SetObjectField(TEXT("boundsCm"), Summary->GetObjectField(TEXT("boundsCm")).ToSharedRef());
    Out->SetArrayField(TEXT("originCm"), Summary->GetArrayField(TEXT("originCm")));
    TSharedRef<FJsonObject> Totals = MakeShared<FJsonObject>();
    Totals->SetNumberField(TEXT("actors"), Snapshot.Actors.Num());
    Totals->SetNumberField(TEXT("nodes"), Snapshot.Nodes.Num());
    Totals->SetNumberField(TEXT("clusters"), Snapshot.Clusters.Num());
    Totals->SetNumberField(TEXT("splats"), Snapshot.Splats.Num());
    Out->SetObjectField(TEXT("totals"), Totals);

    TArray<TSharedPtr<FJsonValue>> Items;
    Items.Reserve(Limit);
    int32 Matched = 0;
    auto Take = [&Items, &Matched, Offset, Limit](const TSharedPtr<FJsonValue>& Value)
    {
        if (Matched >= Offset && Items.Num() < Limit) Items.Add(Value);
        ++Matched;
    };
    if (Section == TEXT("actors") || Section == TEXT("nodes") || Section == TEXT("clusters"))
    {
        const TSharedRef<FJsonObject> Page = HaybaWorldGeometry::ToMetadataJson(
            Snapshot, false, Section, Offset, Limit);
        const TArray<TSharedPtr<FJsonValue>>& Rows = Page->GetArrayField(Section);
        Matched = Section == TEXT("actors") ? Snapshot.Actors.Num()
            : Section == TEXT("nodes") ? Snapshot.Nodes.Num() : Snapshot.Clusters.Num();
        for (int32 Row = 0; Row < Rows.Num(); ++Row)
        {
            TSharedPtr<FJsonObject> Item = Rows[Row]->AsObject();
            Item->SetNumberField(TEXT("index"), Offset + Row);
            if (Section == TEXT("clusters"))
            {
                const int32 ActorMembers = Item->GetArrayField(TEXT("actorIndices")).Num();
                const int32 NodeMembers = Item->GetArrayField(TEXT("nodeIndices")).Num();
                Item->RemoveField(TEXT("actorIndices"));
                Item->RemoveField(TEXT("nodeIndices"));
                Item->SetNumberField(TEXT("actorMemberCount"), ActorMembers);
                Item->SetNumberField(TEXT("nodeMemberCount"), NodeMembers);
            }
            Items.Add(Rows[Row]);
        }
    }
    else if (Section == TEXT("members"))
    {
        const HaybaWorldGeometry::FCluster& Cluster = Snapshot.Clusters[ClusterIndex];
        const TArray<int32>& Members = MemberKind == TEXT("actors") ? Cluster.ActorIndices : Cluster.NodeIndices;
        Out->SetNumberField(TEXT("cluster_index"), ClusterIndex);
        Out->SetStringField(TEXT("member_kind"), MemberKind);
        for (const int32 Member : Members) Take(MakeShared<FJsonValueNumber>(Member));
    }
    else if (Section == TEXT("splats"))
    {
        if (ClusterIndex != INDEX_NONE) Out->SetNumberField(TEXT("cluster_index"), ClusterIndex);
        if (NodeIndex != INDEX_NONE) Out->SetNumberField(TEXT("node_index"), NodeIndex);
        for (int32 Index = 0; Index < Snapshot.Splats.Num(); ++Index)
        {
            const HaybaWorldGeometry::FSplat& Splat = Snapshot.Splats[Index];
            bool bInCluster = ClusterIndex == INDEX_NONE;
            for (int32 At = Splat.ClusterIndex; !bInCluster && Snapshot.Clusters.IsValidIndex(At); At = Snapshot.Clusters[At].ParentIndex)
                bInCluster = At == ClusterIndex;
            bool bInNode = NodeIndex == INDEX_NONE;
            for (int32 At = Splat.NodeIndex; !bInNode && Snapshot.Nodes.IsValidIndex(At); At = Snapshot.Nodes[At].ParentIndex)
                bInNode = At == NodeIndex;
            if (bInCluster && bInNode)
            {
                if (Matched >= Offset && Items.Num() < Limit)
                    Items.Add(HaybaWorldGeometry::SplatToJson(Splat));
                ++Matched;
            }
        }
    }
    Out->SetNumberField(TEXT("total_items"), Matched);
    if (Offset + Items.Num() < Matched) Out->SetNumberField(TEXT("next_offset"), Offset + Items.Num());
    else Out->SetField(TEXT("next_offset"), MakeShared<FJsonValueNull>());
    Out->SetArrayField(TEXT("items"), MoveTemp(Items));
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::ViewDepthSnapshot(
    const TSharedPtr<FJsonObject>& P, UWorld* World)
{
    FString Section = TEXT("overview");
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("section"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: section must be a string"));
    P->TryGetStringField(TEXT("section"), Section);
    if (Section != TEXT("overview") && Section != TEXT("groups") && Section != TEXT("points"))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: view_depth section must be overview, groups, or points"));

    auto ReadPageNumber = [&P](const TCHAR* Name, int32 Default, int32 Max, int32& Out)
    {
        Out = Default;
        const TSharedPtr<FJsonValue>* Value = P->Values.Find(Name);
        if (!Value) return true;
        if (!Value->IsValid() || (*Value)->Type != EJson::Number) return false;
        const double Number = (*Value)->AsNumber();
        if (!FMath::IsFinite(Number) || Number < 0.0 || Number > Max ||
            FMath::FloorToDouble(Number) != Number) return false;
        Out = static_cast<int32>(Number);
        return true;
    };
    int32 Offset = 0, Limit = 32;
    if (!ReadPageNumber(TEXT("offset"), 0, 100000, Offset) ||
        !ReadPageNumber(TEXT("limit"), 32, 32, Limit) || Limit == 0)
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid depth pagination"));
    if (P->HasField(TEXT("cluster_index")) || P->HasField(TEXT("node_index")) ||
        P->HasField(TEXT("expected_scan_id")) || P->HasField(TEXT("tile_id")) ||
        P->HasField(TEXT("page_id")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: mesh filter does not apply to view_depth"));

    FString GroupId;
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("group_id"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: group_id must be a string"));
    P->TryGetStringField(TEXT("group_id"), GroupId);
    if (GroupId.Len() > 64 || (!GroupId.IsEmpty() &&
        (Section != TEXT("points") || !GroupId.StartsWith(TEXT("cell:")))))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid depth group_id"));

    FString ExpectedCaptureId;
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("expected_capture_id"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: expected_capture_id must be a string"));
    if (P->TryGetStringField(TEXT("expected_capture_id"), ExpectedCaptureId))
    {
        if (ExpectedCaptureId.Len() != 32)
            return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_capture_id"));
        for (const TCHAR Digit : ExpectedCaptureId)
            if (!((Digit >= TEXT('0') && Digit <= TEXT('9')) ||
                (Digit >= TEXT('A') && Digit <= TEXT('F')) ||
                (Digit >= TEXT('a') && Digit <= TEXT('f'))))
                return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_capture_id"));
    }
    const TSharedPtr<const HaybaViewDepthSnapshot::FSnapshot> Snapshot =
        HaybaViewDepthSnapshot::GetForWorld(World);
    if (!ExpectedCaptureId.IsEmpty() && (!Snapshot.IsValid() ||
        !ExpectedCaptureId.Equals(Snapshot->CaptureId, ESearchCase::IgnoreCase)))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: capture changed; restart pagination"));
    if (!Snapshot.IsValid())
    {
        TSharedRef<FJsonObject> Out = HaybaViewDepthSnapshot::BuildNotCaptured();
        Out->SetStringField(TEXT("section"), Section);
        Out->SetNumberField(TEXT("offset"), Offset);
        Out->SetNumberField(TEXT("limit"), Limit);
        return FHaybaHandlerResult::Ok(Out);
    }
    return FHaybaHandlerResult::Ok(
        HaybaViewDepthSnapshot::BuildPage(*Snapshot, Section, Offset, Limit, GroupId));
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::WorldTileCapture(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid())
        return FHaybaHandlerResult::Err(TEXT("world_tile_capture: parameters must be an object"));

    FString Action;
    if (!P->TryGetStringField(TEXT("action"), Action) ||
        (Action != TEXT("start") && Action != TEXT("status") && Action != TEXT("cancel")))
        return FHaybaHandlerResult::Err(TEXT("world_tile_capture: action must be start, status, or cancel"));

    auto ReadOptionalString = [&P](const TCHAR* Name, FString& Out) -> bool
    {
        if (!P->HasField(Name)) return true;
        return P->TryGetStringField(Name, Out) && !Out.IsEmpty();
    };
    FString TileId;
    FString CaptureId;
    if (!ReadOptionalString(TEXT("tile_id"), TileId) ||
        !ReadOptionalString(TEXT("capture_id"), CaptureId) ||
        TileId.Len() > 96 || CaptureId.Len() > 32)
        return FHaybaHandlerResult::Err(TEXT("world_tile_capture: invalid tile_id or capture_id"));
    if (!CaptureId.IsEmpty())
    {
        if (CaptureId.Len() != 32)
            return FHaybaHandlerResult::Err(TEXT("world_tile_capture: capture_id must be 32 hexadecimal characters"));
        for (const TCHAR Digit : CaptureId)
            if (!FChar::IsHexDigit(Digit))
                return FHaybaHandlerResult::Err(TEXT("world_tile_capture: capture_id must be 32 hexadecimal characters"));
    }
    const bool bHasPosition = P->HasField(TEXT("position_cm"));
    const bool bHasLOD = P->HasField(TEXT("lod"));
    if ((Action == TEXT("start") &&
            (!CaptureId.IsEmpty() || (TileId.IsEmpty() == bHasPosition) || (bHasPosition != bHasLOD))) ||
        (Action != TEXT("start") &&
            ((TileId.IsEmpty() == CaptureId.IsEmpty()) || bHasPosition || bHasLOD)))
        return FHaybaHandlerResult::Err(TEXT("world_tile_capture: start requires tile_id or position_cm with lod; status and cancel require exactly one of capture_id or tile_id"));

    int32 LOD = 0, TileX = 0, TileY = 0, TileZ = 0;
    if (bHasPosition)
    {
        const TSharedPtr<FJsonObject>* Position = nullptr;
        const TSharedPtr<FJsonValue>* LODValue = P->Values.Find(TEXT("lod"));
        if (!P->TryGetObjectField(TEXT("position_cm"), Position) ||
            !Position || !Position->IsValid() || !LODValue ||
            !LODValue->IsValid() || (*LODValue)->Type != EJson::Number)
            return FHaybaHandlerResult::Err(TEXT("world_tile_capture: position_cm must be an object and lod must be 0, 1, or 2"));
        const double LODNumber = (*LODValue)->AsNumber();
        if (!FMath::IsFinite(LODNumber) || FMath::FloorToDouble(LODNumber) != LODNumber ||
            LODNumber < 0.0 || LODNumber > 2.0)
            return FHaybaHandlerResult::Err(TEXT("world_tile_capture: lod must be 0, 1, or 2"));
        LOD = static_cast<int32>(LODNumber);
        double Coordinates[3] = {};
        constexpr const TCHAR* CoordinateNames[] = {TEXT("x"), TEXT("y"), TEXT("z")};
        for (int32 Axis = 0; Axis < 3; ++Axis)
        {
            const TSharedPtr<FJsonValue>* Value = (*Position)->Values.Find(CoordinateNames[Axis]);
            if (!Value || !Value->IsValid() || (*Value)->Type != EJson::Number ||
                !FMath::IsFinite((*Value)->AsNumber()) ||
                FMath::Abs((*Value)->AsNumber()) > 100000000.0)
                return FHaybaHandlerResult::Err(TEXT("world_tile_capture: position_cm requires finite x, y, z within 100000000 cm"));
            Coordinates[Axis] = (*Value)->AsNumber();
        }
        const double EdgeCm = 4000.0 / static_cast<double>(1 << LOD);
        TileX = FMath::FloorToInt(Coordinates[0] / EdgeCm);
        TileY = FMath::FloorToInt(Coordinates[1] / EdgeCm);
        TileZ = FMath::FloorToInt(Coordinates[2] / EdgeCm);
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    HaybaWorldTileCapture::FStatus Status;
    HaybaWorldTileCapture::FStartResult Started;
    if (Action == TEXT("start"))
    {
        // The service validates tile bounds and editor safety before queuing any
        // work. A rejected start is still a machine-readable state for callers.
        Started = bHasPosition
            ? HaybaWorldTileCapture::Start(World, LOD, TileX, TileY, TileZ)
            : HaybaWorldTileCapture::StartById(World, TileId);
        Status = Started.Status;
    }
    else if (Action == TEXT("cancel"))
    {
        Status = HaybaWorldTileCapture::Cancel(World,
            CaptureId.IsEmpty() ? TileId : CaptureId);
    }
    else
    {
        Status = HaybaWorldTileCapture::GetStatus(World,
            CaptureId.IsEmpty() ? TileId : CaptureId);
    }

    TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("action"), Action);
    Out->SetStringField(TEXT("status"), HaybaWorldTileCapture::StateName(Status.State));
    Out->SetStringField(TEXT("tile_id"), Status.TileId);
    Out->SetStringField(TEXT("capture_id"), Status.CaptureId);
    Out->SetNumberField(TEXT("scanned_actor_slots"), Status.ScannedActorSlots);
    Out->SetNumberField(TEXT("eligible_actor_count"), Status.EligibleActorCount);
    Out->SetNumberField(TEXT("processed_actor_count"), Status.ProcessedActorCount);
    Out->SetNumberField(TEXT("point_count"), Status.PointCount);
    Out->SetNumberField(TEXT("page_count"), Status.PageCount);
    TArray<TSharedPtr<FJsonValue>> Gaps;
    for (const FString& Gap : Status.Gaps)
        Gaps.Add(MakeShared<FJsonValueString>(Gap));
    Out->SetArrayField(TEXT("gaps"), MoveTemp(Gaps));
    if (Action == TEXT("start"))
    {
        Out->SetBoolField(TEXT("deduplicated"), Started.bDeduplicated);
        if (!Started.Error.IsEmpty()) Out->SetStringField(TEXT("reason"), Started.Error);
    }
    if (Status.Snapshot.IsValid())
        Out->SetStringField(TEXT("captured_at_utc"), Status.Snapshot->CapturedAtUtc);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::WorldTileSnapshot(
    const TSharedPtr<FJsonObject>& P, UWorld* World)
{
    FString Section = TEXT("overview");
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("section"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: section must be a string"));
    P->TryGetStringField(TEXT("section"), Section);
    if (Section != TEXT("overview") && Section != TEXT("pages") && Section != TEXT("semantic") &&
        Section != TEXT("relations") &&
        Section != TEXT("nodes") && Section != TEXT("points"))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: mesh_tile section must be overview, pages, semantic, relations, nodes, or points"));
    if (P->HasField(TEXT("cluster_index")) || P->HasField(TEXT("node_index")) ||
        P->HasField(TEXT("expected_scan_id")) || P->HasField(TEXT("group_id")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: mesh filters do not apply to mesh_tile"));

    FString TileId;
    if (!P->TryGetStringField(TEXT("tile_id"), TileId))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: mesh_tile requires tile_id"));
    TArray<FString> Parts;
    TileId.ParseIntoArray(Parts, TEXT(":"), false);
    if (TileId.Len() > 96 || Parts.Num() != 5 || Parts[0] != TEXT("tile") ||
        (Parts[1] != TEXT("0") && Parts[1] != TEXT("1") && Parts[1] != TEXT("2")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid tile_id"));
    for (int32 PartIndex = 2; PartIndex < Parts.Num(); ++PartIndex)
    {
        const FString& Part = Parts[PartIndex];
        const int32 FirstDigit = Part.StartsWith(TEXT("-")) ? 1 : 0;
        if (Part.Len() <= FirstDigit || Part.Len() > 12)
            return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid tile_id"));
        for (int32 CharIndex = FirstDigit; CharIndex < Part.Len(); ++CharIndex)
            if (!FChar::IsDigit(Part[CharIndex]))
                return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid tile_id"));
    }

    auto ReadPageNumber = [&P](const TCHAR* Name, int32 Default, int32 Max, int32& Out)
    {
        Out = Default;
        const TSharedPtr<FJsonValue>* Value = P->Values.Find(Name);
        if (!Value) return true;
        if (!Value->IsValid() || (*Value)->Type != EJson::Number) return false;
        const double Number = (*Value)->AsNumber();
        if (!FMath::IsFinite(Number) || Number < 0.0 || Number > Max ||
            FMath::FloorToDouble(Number) != Number) return false;
        Out = static_cast<int32>(Number);
        return true;
    };
    int32 Offset = 0, Limit = 32, PageId = INDEX_NONE;
    if (!ReadPageNumber(TEXT("offset"), 0, 100000, Offset) ||
        !ReadPageNumber(TEXT("limit"), 32, 32, Limit) || Limit == 0 ||
        !ReadPageNumber(TEXT("page_id"), INDEX_NONE, 100000, PageId))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: invalid tile pagination"));
    if ((Section == TEXT("nodes") || Section == TEXT("points")) && PageId == INDEX_NONE)
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: page_id is required for tile nodes and points"));
    if ((Section == TEXT("overview") || Section == TEXT("pages") ||
        Section == TEXT("semantic") || Section == TEXT("relations")) && P->HasField(TEXT("page_id")))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: page_id applies only to tile nodes and points"));

    FString ExpectedCaptureId;
    if (const TSharedPtr<FJsonValue>* Value = P->Values.Find(TEXT("expected_capture_id"));
        Value && (!Value->IsValid() || (*Value)->Type != EJson::String))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: expected_capture_id must be a string"));
    if (P->TryGetStringField(TEXT("expected_capture_id"), ExpectedCaptureId))
    {
        if (ExpectedCaptureId.Len() != 32)
            return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_capture_id"));
        for (const TCHAR Digit : ExpectedCaptureId)
            if (!FChar::IsHexDigit(Digit))
                return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: malformed expected_capture_id"));
    }
    if (Section != TEXT("overview") && ExpectedCaptureId.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: read tile overview first, then pass expected_capture_id"));
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Snapshot =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, ExpectedCaptureId);
    if (!ExpectedCaptureId.IsEmpty() && (!Snapshot.IsValid() ||
        !ExpectedCaptureId.Equals(Snapshot->CaptureId, ESearchCase::IgnoreCase)))
        return FHaybaHandlerResult::Err(TEXT("world_semantic_snapshot: tile capture changed; restart pagination"));
    if (!Snapshot.IsValid())
    {
        TSharedRef<FJsonObject> Out = HaybaWorldTileSnapshot::BuildNotCaptured(TileId);
        Out->SetStringField(TEXT("section"), Section);
        Out->SetNumberField(TEXT("offset"), Offset);
        Out->SetNumberField(TEXT("limit"), Limit);
        return FHaybaHandlerResult::Ok(Out);
    }
    TSharedRef<FJsonObject> Out = Section == TEXT("relations")
        ? HaybaWorldRelations::BuildPage(HaybaWorldRelations::Build(*Snapshot), Offset, Limit)
        : HaybaWorldTileSnapshot::BuildPage(*Snapshot,
            Section == TEXT("overview") ? TEXT("summary") : Section, PageId, Offset, Limit);
    Out->SetStringField(TEXT("section"), Section);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::WorldQuery(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid())
        return FHaybaHandlerResult::Err(TEXT("world_query: parameters must be an object"));
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("world_query: no editor world"));

    FString TileId, CaptureId;
    if (!P->TryGetStringField(TEXT("tile_id"), TileId) ||
        !P->TryGetStringField(TEXT("expected_capture_id"), CaptureId))
        return FHaybaHandlerResult::Err(TEXT("world_query: tile_id and expected_capture_id are required"));
    TArray<FString> Parts;
    TileId.ParseIntoArray(Parts, TEXT(":"), false);
    if (TileId.Len() > 96 || Parts.Num() != 5 || Parts[0] != TEXT("tile") ||
        (Parts[1] != TEXT("0") && Parts[1] != TEXT("1") && Parts[1] != TEXT("2")) ||
        CaptureId.Len() != 32)
        return FHaybaHandlerResult::Err(TEXT("world_query: malformed tile or capture ID"));
    for (int32 Index = 2; Index < Parts.Num(); ++Index)
    {
        const FString& Part = Parts[Index];
        const int32 FirstDigit = Part.StartsWith(TEXT("-")) ? 1 : 0;
        if (Part.Len() <= FirstDigit || Part.Len() > 12)
            return FHaybaHandlerResult::Err(TEXT("world_query: malformed tile ID"));
        for (int32 CharIndex = FirstDigit; CharIndex < Part.Len(); ++CharIndex)
            if (!FChar::IsDigit(Part[CharIndex]))
                return FHaybaHandlerResult::Err(TEXT("world_query: malformed tile ID"));
    }
    for (const TCHAR Digit : CaptureId)
        if (!FChar::IsHexDigit(Digit))
            return FHaybaHandlerResult::Err(TEXT("world_query: malformed capture ID"));

    auto ReadFact = [](const TSharedPtr<FJsonObject>& Parent, const TCHAR* Name,
        HaybaWorldQuery::FFact& Out, bool bRequired) -> bool
    {
        const TSharedPtr<FJsonObject>* Fact = nullptr;
        if (!Parent->TryGetObjectField(Name, Fact) || !Fact || !Fact->IsValid())
            return !bRequired && !Parent->HasField(Name);
        return (*Fact)->TryGetStringField(TEXT("kind"), Out.Kind) &&
            (*Fact)->TryGetStringField(TEXT("value"), Out.Value);
    };
    HaybaWorldQuery::FRequest Request;
    if (!ReadFact(P, TEXT("target"), Request.Target, true) ||
        !ReadFact(P, TEXT("reference"), Request.Reference, false))
        return FHaybaHandlerResult::Err(TEXT("world_query: malformed authored fact"));
    if (P->HasField(TEXT("reference_source_node_id")) &&
        !P->TryGetStringField(TEXT("reference_source_node_id"), Request.ReferenceSourceNodeId))
        return FHaybaHandlerResult::Err(TEXT("world_query: malformed reference source"));
    if (P->HasField(TEXT("relation_kind")) &&
        !P->TryGetStringField(TEXT("relation_kind"), Request.RelationKind))
        return FHaybaHandlerResult::Err(TEXT("world_query: malformed relation"));
    auto ReadNumber = [&P](const TCHAR* Name, double& Out) -> bool
    {
        return !P->HasField(Name) || P->TryGetNumberField(Name, Out);
    };
    if (!ReadNumber(TEXT("near_threshold_cm"), Request.NearThresholdCm) ||
        !ReadNumber(TEXT("above_minimum_gap_cm"), Request.AboveMinimumGapCm) ||
        !ReadNumber(TEXT("above_maximum_gap_cm"), Request.AboveMaximumGapCm))
        return FHaybaHandlerResult::Err(TEXT("world_query: malformed threshold"));
    FString Error;
    if (!HaybaWorldQuery::ValidateRequest(Request, Error))
        return FHaybaHandlerResult::Err(TEXT("world_query: ") + Error);
    auto ReadPageNumber = [&P](const TCHAR* Name, int32 Default, int32 Max, int32& Out) -> bool
    {
        Out = Default;
        if (!P->HasField(Name)) return true;
        double Number = 0.0;
        if (!P->TryGetNumberField(Name, Number) || !FMath::IsFinite(Number) ||
            Number < 0.0 || Number > Max || FMath::FloorToDouble(Number) != Number)
            return false;
        Out = static_cast<int32>(Number);
        return true;
    };
    int32 Offset = 0, Limit = 32;
    if (!ReadPageNumber(TEXT("offset"), 0, 100000, Offset) ||
        !ReadPageNumber(TEXT("limit"), 32, 32, Limit) || Limit == 0)
        return FHaybaHandlerResult::Err(TEXT("world_query: invalid pagination"));
    const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Snapshot =
        HaybaWorldTileSnapshot::GetForWorld(World, TileId, CaptureId);
    if (!Snapshot.IsValid() ||
        !CaptureId.Equals(Snapshot->CaptureId, ESearchCase::IgnoreCase))
        return FHaybaHandlerResult::Err(TEXT("world_query: pinned capture is unavailable; recapture the tile"));
    return FHaybaHandlerResult::Ok(HaybaWorldQuery::BuildPage(
        HaybaWorldQuery::Build(*Snapshot, Request), Offset, Limit));
}

// ---------------------------------------------------------------------------
// scene_validate_physics
// ---------------------------------------------------------------------------

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::ValidatePhysics(const TSharedPtr<FJsonObject>& P)
{
    bool bDeepCheck = false;
    P->TryGetBoolField(TEXT("deep_check"), bDeepCheck);

    if (bDeepCheck)
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("deep_check_required"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("scene_validate_physics: no editor world"));

    FBox Window = ParseWindow(P);
    // Collect generously — class filtering below removes most system actors
    // (lights, sky, landscape proxies, …). The cap targets actual geometry
    // checks, not the unfiltered actor list.
    TArray<AActor*> Actors = CollectInWindow(World, Window, 5000);

    constexpr int32 PhysicsCheckBudget = 250;
    TArray<TSharedPtr<FJsonValue>> FloatingList;
    TArray<TSharedPtr<FJsonValue>> InterpenetratingList;

    int32 SkippedSystem = 0;
    int32 Checked = 0;
    for (AActor* A : Actors)
    {
        if (ShouldSkipPhysicsCheck(A)) { ++SkippedSystem; continue; }

        FBox Bounds = A->GetComponentsBoundingBox(true);
        FVector Extent = Bounds.GetExtent();
        if (Extent.IsNearlyZero()) continue;

        // Stop once we've actually physics-checked enough real actors. The
        // cap targets meaningful checks, not the unfiltered scan.
        if (++Checked > PhysicsCheckBudget) break;

        FVector Loc = A->GetActorLocation();

        // Floating check - downward line trace
        FHitResult Hit;
        FVector Start = Loc + FVector(0.f, 0.f, 5.f);
        FVector End   = Loc - FVector(0.f, 0.f, Extent.Z * 2.f + 100.f);
        FCollisionQueryParams TraceParams(TEXT("HaybaPhysicsCheck"), false, A);

        bool bHit = World->LineTraceSingleByChannel(Hit, Start, End, ECC_WorldStatic, TraceParams);
        if (!bHit)
        {
            TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("id"), A->GetName());
            TArray<TSharedPtr<FJsonValue>> LocArr = {
                MakeShared<FJsonValueNumber>(Loc.X),
                MakeShared<FJsonValueNumber>(Loc.Y),
                MakeShared<FJsonValueNumber>(Loc.Z),
            };
            Entry->SetArrayField(TEXT("location"), LocArr);
            FloatingList.Add(MakeShared<FJsonValueObject>(Entry));
        }

        // Interpenetration check
        float SphereRadius = Extent.GetMax();
        FCollisionObjectQueryParams ObjParams(FCollisionObjectQueryParams::AllObjects);
        FCollisionShape Sphere = FCollisionShape::MakeSphere(SphereRadius);
        TArray<FOverlapResult> Overlaps;
        World->OverlapMultiByObjectType(Overlaps, Loc, FQuat::Identity, ObjParams, Sphere,
            FCollisionQueryParams(TEXT("HaybaOverlap"), false, A));

        for (const FOverlapResult& Ov : Overlaps)
        {
            AActor* OvActor = Ov.GetActor();
            if (!OvActor || OvActor == A) continue;
            // Filter the other side of the pair too — overlap with a landscape
            // proxy / HLOD instancing actor is geometry-by-design, not a bug.
            if (ShouldSkipPhysicsCheck(OvActor)) continue;

            TSharedRef<FJsonObject> Pair = MakeShared<FJsonObject>();
            Pair->SetStringField(TEXT("id_a"), A->GetName());
            Pair->SetStringField(TEXT("id_b"), OvActor->GetName());
            InterpenetratingList.Add(MakeShared<FJsonValueObject>(Pair));
            break; // one entry per actor is enough to flag it
        }
    }

    bool bValid = FloatingList.Num() == 0 && InterpenetratingList.Num() == 0;
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("valid"), bValid);
    Out->SetArrayField(TEXT("floating"), FloatingList);
    Out->SetArrayField(TEXT("interpenetrating"), InterpenetratingList);
    Out->SetNumberField(TEXT("checked_count"), Checked);
    Out->SetNumberField(TEXT("scanned_actors"), Actors.Num());
    Out->SetNumberField(TEXT("skipped_system_actors"), SkippedSystem);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// scene_get_actor_relations
// ---------------------------------------------------------------------------

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::GetActorRelations(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    FHaybaParamReader ParamR(P, TEXT("scene_get_actor_relations"));
    ActorId = ParamR.RequiredString(TEXT("actor_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    double RadiusDbl = 2000.0;
    P->TryGetNumberField(TEXT("radius"), RadiusDbl);
    float Radius = (float)RadiusDbl;

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("scene_get_actor_relations: no editor world"));

    // Find focal actor
    AActor* Focal = nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if ((*It)->GetName() == ActorId) { Focal = *It; break; }
    }
    if (!Focal)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("scene_get_actor_relations: actor not found: %s"), *ActorId));

    FVector FocalLoc = Focal->GetActorLocation();

    static constexpr int32 ActorCap = 500;
    int32 CollectedCount = 0;
    bool bCapped = false;

    TArray<TSharedPtr<FJsonValue>> Relations;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (CollectedCount >= ActorCap) { bCapped = true; break; }

        AActor* A = *It;
        if (!A || A == Focal) continue;
        if (A->ActorHasTag(TEXT("HaybaMCPCaptureActor"))) continue;

        ++CollectedCount;

        float Dist = FVector::Dist(FocalLoc, A->GetActorLocation());
        if (Dist > Radius) continue;

        // Skip actors beyond 2000uu (they would be classified "far")
        if (Dist >= 2000.f) continue;

        FString Relation;
        if (Dist < 200.f) Relation = TEXT("adjacent_to");
        else              Relation = TEXT("near");

        TSharedRef<FJsonObject> Rel = MakeShared<FJsonObject>();
        Rel->SetStringField(TEXT("id"),       A->GetName());
        Rel->SetStringField(TEXT("label"),    A->GetActorLabel());
        Rel->SetStringField(TEXT("class"),    A->GetClass()->GetName());
        Rel->SetNumberField(TEXT("distance"), Dist);
        Rel->SetStringField(TEXT("relation"), Relation);
        Relations.Add(MakeShared<FJsonValueObject>(Rel));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetArrayField(TEXT("relations"), Relations);
    Out->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Out);
}
