#include "HaybaMCPFoliageHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Engine/StaticMesh.h"
#include "InstancedFoliageActor.h"
#include "FoliageType.h"
#include "FoliageType_InstancedStaticMesh.h"
#include "FoliageInstancedStaticMeshComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPFoliage, Log, All);

namespace
{
    static bool IsFiniteVector(const FVector& Value)
    {
        return FMath::IsFinite(Value.X) && FMath::IsFinite(Value.Y) && FMath::IsFinite(Value.Z);
    }

    static bool ReadVec(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, FVector& Out)
    {
        if (!Obj.IsValid()) return false;

        // The TypeScript tools publish vectors as {x,y,z}. Keep accepting the
        // historic [x,y,z] spelling as well, but never call AsNumber() on an
        // unchecked JSON value: malformed input must be an error, not an engine
        // assertion or a silently fabricated zero.
        const TSharedPtr<FJsonObject>* VectorObj = nullptr;
        if (Obj->TryGetObjectField(Field, VectorObj) && VectorObj && VectorObj->IsValid())
        {
            double X = 0.0, Y = 0.0, Z = 0.0;
            if (!(*VectorObj)->TryGetNumberField(TEXT("x"), X) ||
                !(*VectorObj)->TryGetNumberField(TEXT("y"), Y) ||
                !(*VectorObj)->TryGetNumberField(TEXT("z"), Z))
            {
                return false;
            }
            Out = FVector(X, Y, Z);
            return IsFiniteVector(Out);
        }

        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        if (!Obj->TryGetArrayField(Field, Arr) || !Arr || Arr->Num() != 3) return false;
        double Values[3] = {};
        for (int32 Index = 0; Index < 3; ++Index)
        {
            if (!(*Arr)[Index].IsValid() || !(*Arr)[Index]->TryGetNumber(Values[Index])) return false;
        }
        Out = FVector(Values[0], Values[1], Values[2]);
        return IsFiniteVector(Out);
    }

    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static UFoliageType* ResolveFoliageType(const FString& Path)
    {
        UObject* Loaded = LoadObject<UObject>(nullptr, *Path);
        return Cast<UFoliageType>(Loaded);
    }

    static int32 CountInstances(UWorld* World, const UFoliageType* Type)
    {
        int32 Count = 0;
        for (TActorIterator<AInstancedFoliageActor> It(World); It; ++It)
        {
            if (const FFoliageInfo* Info = It->FindInfo(Type)) Count += Info->Instances.Num();
        }
        return Count;
    }

    // UE 5.8 declares AInstancedFoliageActor::AddInstances as a Blueprint
    // helper on a MinimalAPI class but does not export the function. Calling it
    // directly therefore compiles and then fails LNK2019 on a clean build. Use
    // only the explicitly FOLIAGE_API-exported pieces of the same operation.
    static bool AddFoliageTransforms(UWorld* World, UFoliageType* Type,
        const TArray<FTransform>& Transforms, FString& OutError)
    {
        if (!World || !Type)
        {
            OutError = TEXT("invalid world or foliage type");
            return false;
        }
        for (int32 Index = 0; Index < Transforms.Num(); ++Index)
        {
            const FTransform& Transform = Transforms[Index];
            AInstancedFoliageActor* IFA = AInstancedFoliageActor::Get(
                World, /*bCreateIfNone=*/true, World->GetCurrentLevel(), Transform.GetLocation());
            if (!IFA)
            {
                OutError = FString::Printf(TEXT("could not resolve/create InstancedFoliageActor for transform %d"), Index);
                return false;
            }
            IFA->Modify();
            FFoliageInfo* Info = nullptr;
            UFoliageType* LocalType = IFA->AddFoliageType(Type, &Info);
            if (!LocalType || !Info)
            {
                OutError = FString::Printf(TEXT("AddFoliageType returned no usable foliage info for transform %d"), Index);
                return false;
            }
            FFoliageInstance Instance;
            Instance.SetInstanceWorldTransform(Transform);
            Info->AddInstance(LocalType, Instance);
        }
        return true;
    }
}

TArray<FString> FHaybaMCPFoliageHandler::GetCommands() const
{
    return {
        TEXT("foliage_add_instance"),
        TEXT("foliage_remove_instances"),
        TEXT("foliage_list_types"),
        TEXT("foliage_paint_at"),
    };
}

FHaybaHandlerResult FHaybaMCPFoliageHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("foliage_add_instance"))     return FoliageAddInstance(P);
    if (Cmd == TEXT("foliage_remove_instances")) return FoliageRemoveInstances(P);
    if (Cmd == TEXT("foliage_list_types"))       return FoliageListTypes(P);
    if (Cmd == TEXT("foliage_paint_at"))         return FoliagePaintAt(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("FoliageHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPFoliageHandler::FoliageAddInstance(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: no editor world"));

    FString Path;
    if (!P->TryGetStringField(TEXT("foliage_type_path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: missing foliage_type_path"));

    const TSharedPtr<FJsonObject>* TransformObj;
    if (!P->TryGetObjectField(TEXT("transform"), TransformObj))
        return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: missing transform"));

    FVector Loc = FVector::ZeroVector;
    if (!ReadVec(*TransformObj, TEXT("location"), Loc))
        return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: transform.location required"));

    FVector RotVec = FVector::ZeroVector;
    ReadVec(*TransformObj, TEXT("rotation"), RotVec);
    FRotator Rot(RotVec.X, RotVec.Y, RotVec.Z);

    FVector Scale = FVector::OneVector;
    ReadVec(*TransformObj, TEXT("scale"), Scale);

    UFoliageType* Type = ResolveFoliageType(Path);
    if (!Type) return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("foliage_add_instance: '%s' did not resolve to a UFoliageType asset"), *Path));

    const int32 Before = CountInstances(World, Type);
    const TArray<FTransform> Transforms = { FTransform(Rot, Loc, Scale) };
    FString AddError;
    if (!AddFoliageTransforms(World, Type, Transforms, AddError))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("foliage_add_instance: %s"), *AddError));
    const int32 After = CountInstances(World, Type);
    if (After != Before + 1)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("foliage_add_instance: engine reported no persisted instance (before=%d, after=%d)"),
            Before, After));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("added"), true);
    Out->SetNumberField(TEXT("count"), After);
    Out->SetStringField(TEXT("foliage_type_path"), Type->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPFoliageHandler::FoliageRemoveInstances(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("foliage_remove_instances: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("foliage_remove_instances: no editor world"));

    FString Path;
    if (!P->TryGetStringField(TEXT("foliage_type_path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("foliage_remove_instances: missing foliage_type_path"));

    const TSharedPtr<FJsonObject>* BoundsObj;
    if (!P->TryGetObjectField(TEXT("bounds"), BoundsObj))
        return FHaybaHandlerResult::Err(TEXT("foliage_remove_instances: missing bounds"));

    FVector Min, Max;
    if (!ReadVec(*BoundsObj, TEXT("min"), Min) || !ReadVec(*BoundsObj, TEXT("max"), Max))
        return FHaybaHandlerResult::Err(TEXT("foliage_remove_instances: bounds.min/max required"));

    FBox Bounds(Min, Max);

    UFoliageType* Type = ResolveFoliageType(Path);
    // Honesty: a path that fails to load or isn't a UFoliageType is a caller
    // error, not a successful removal of zero instances.
    if (!Type)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("foliage_remove_instances: '%s' did not resolve to a UFoliageType"), *Path));

    int32 Removed = 0;
    for (TActorIterator<AInstancedFoliageActor> It(World); It; ++It)
    {
        if (FFoliageInfo* Info = It->FindInfo(Type))
        {
            TArray<int32> ToRemove;
            for (int32 i = 0; i < Info->Instances.Num(); ++i)
            {
                if (Bounds.IsInside(Info->Instances[i].Location))
                    ToRemove.Add(i);
            }
            Removed += ToRemove.Num();
            if (ToRemove.Num() > 0)
            {
                Info->RemoveInstances(ToRemove, true);
            }
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("removed"), Removed);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPFoliageHandler::FoliageListTypes(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("foliage_list_types: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("foliage_list_types: no editor world"));

    TMap<UFoliageType*, int32> Counts;
    for (TActorIterator<AInstancedFoliageActor> It(World); It; ++It)
    {
        for (const auto& Pair : It->GetFoliageInfos())
        {
            UFoliageType* Type = Pair.Key;
            const auto& Info = Pair.Value;
            if (!Type) continue;
            Counts.FindOrAdd(Type) += Info->Instances.Num();
        }
    }

    TArray<TSharedPtr<FJsonValue>> Types;
    for (const auto& Pair : Counts)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("path"), Pair.Key->GetPathName());
        Entry->SetNumberField(TEXT("count"), Pair.Value);
        Types.Add(MakeShared<FJsonValueObject>(Entry));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("types"), Types);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPFoliageHandler::FoliagePaintAt(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: no editor world"));

    FString Path;
    if (!P->TryGetStringField(TEXT("foliage_type_path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: missing foliage_type_path"));

    FVector Center = FVector::ZeroVector;
    if (!ReadVec(P, TEXT("location"), Center))
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: missing location"));

    double Radius = 200.0;
    P->TryGetNumberField(TEXT("radius"), Radius);
    if (!FMath::IsFinite(Radius) || Radius <= 0.0 || Radius > 1000000.0)
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: radius must be finite and in (0, 1000000] cm"));

    int32 Density = 5;
    P->TryGetNumberField(TEXT("density"), Density);
    if (Density <= 0 || Density > 10000)
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: density must be an integer in [1, 10000]"));

    int32 Seed = 1337;
    P->TryGetNumberField(TEXT("seed"), Seed);
    UFoliageType* Type = ResolveFoliageType(Path);
    if (!Type) return FHaybaHandlerResult::Err(FString::Printf(
        TEXT("foliage_paint_at: '%s' did not resolve to a UFoliageType asset"), *Path));

    FRandomStream Random(Seed);
    TArray<FTransform> Transforms;
    Transforms.Reserve(Density);
    FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(HaybaFoliagePaint), false);
    const double TraceHalfHeight = 1000000.0;
    for (int32 Index = 0; Index < Density; ++Index)
    {
        const double Angle = Random.FRandRange(0.0f, 2.0f * PI);
        const double Distance = Radius * FMath::Sqrt(Random.FRand());
        const FVector XYOffset(FMath::Cos(Angle) * Distance, FMath::Sin(Angle) * Distance, 0.0);
        FHitResult Hit;
        const FVector Start = Center + XYOffset + FVector(0.0, 0.0, TraceHalfHeight);
        const FVector End = Center + XYOffset - FVector(0.0, 0.0, TraceHalfHeight);
        if (World->LineTraceSingleByChannel(Hit, Start, End, ECC_WorldStatic, QueryParams))
        {
            const FRotator Rotation = FRotationMatrix::MakeFromZ(Hit.ImpactNormal).Rotator();
            Transforms.Add(FTransform(Rotation, Hit.ImpactPoint, FVector::OneVector));
        }
    }
    if (Transforms.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: no WorldStatic surface was hit; no foliage was added"));

    const int32 Before = CountInstances(World, Type);
    FString AddError;
    if (!AddFoliageTransforms(World, Type, Transforms, AddError))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("foliage_paint_at: %s"), *AddError));
    const int32 After = CountInstances(World, Type);
    const int32 Added = After - Before;
    if (Added <= 0)
        return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: engine persisted no foliage instances"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("painted"), Added);
    Out->SetNumberField(TEXT("requested"), Density);
    Out->SetNumberField(TEXT("missed_surface"), Density - Transforms.Num());
    Out->SetNumberField(TEXT("seed"), Seed);
    Out->SetStringField(TEXT("foliage_type_path"), Type->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}
