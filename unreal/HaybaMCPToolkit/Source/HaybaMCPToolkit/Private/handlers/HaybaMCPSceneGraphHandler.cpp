#include "HaybaMCPSceneGraphHandler.h"
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
        TEXT("scene_validate_physics"),
        TEXT("scene_get_actor_relations"),
    };
}

FHaybaHandlerResult FHaybaMCPSceneGraphHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("scene_export"))              return Export(Params);
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
        CacheObj->SetField(Field.Key, Field.Value);

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
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("scene_get_actor_relations: missing actor_id"));

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
