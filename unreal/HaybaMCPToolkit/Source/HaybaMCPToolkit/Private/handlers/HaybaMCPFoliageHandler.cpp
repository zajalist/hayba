#include "HaybaMCPFoliageHandler.h"
#include "Json.h"
#include "Editor.h"
#include "Engine/World.h"
#include "Engine/StaticMesh.h"
#include "InstancedFoliageActor.h"
#include "FoliageType.h"
#include "FoliageType_InstancedStaticMesh.h"
#include "FoliageInstancedStaticMeshComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPFoliage, Log, All);

namespace
{
    static bool ReadVec(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, FVector& Out)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr;
        if (!Obj.IsValid() || !Obj->TryGetArrayField(Field, Arr) || Arr->Num() < 3) return false;
        Out = FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        return true;
    }

    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static UFoliageType* ResolveFoliageType(AInstancedFoliageActor* IFA, const FString& Path)
    {
        UObject* Loaded = LoadObject<UObject>(nullptr, *Path);
        if (!Loaded) return nullptr;
        if (UFoliageType* AsType = Cast<UFoliageType>(Loaded)) return AsType;
        if (UStaticMesh* SM = Cast<UStaticMesh>(Loaded))
        {
            UFoliageType* Created = nullptr;
            IFA->AddMesh(SM, &Created);
            return Created;
        }
        return nullptr;
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

    AInstancedFoliageActor* IFA = AInstancedFoliageActor::Get(World, true);
    if (!IFA) return FHaybaHandlerResult::Err(TEXT("foliage_add_instance: cannot get IFA"));

    UFoliageType* Type = ResolveFoliageType(IFA, Path);
    if (!Type) return FHaybaHandlerResult::Err(FString::Printf(TEXT("foliage_add_instance: cannot load foliage type: %s"), *Path));

    FFoliageInstance Instance;
    Instance.Location = Loc;
    Instance.Rotation = Rot;
    Instance.DrawScale3D = (FVector3f)Scale;
    (void)Instance;

    // Honesty: this operation is not actually implemented — the foliage add API
    // was reworked and no instance is ever persisted. Previously this reported
    // added:true with the PRE-EXISTING count, which lies to the caller. Report a
    // structured error instead until real persistence is wired up.
    return FHaybaHandlerResult::Err(
        TEXT("foliage_add_instance: not implemented — foliage instance persistence is unavailable "
             "on this engine version; no instance was added"));
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

    AInstancedFoliageActor* IFA = AInstancedFoliageActor::Get(World, false);
    if (!IFA)
    {
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetNumberField(TEXT("removed"), 0);
        return FHaybaHandlerResult::Ok(O);
    }

    UObject* Loaded = LoadObject<UObject>(nullptr, *Path);
    UFoliageType* Type = Cast<UFoliageType>(Loaded);
    // Honesty: a path that fails to load or isn't a UFoliageType is a caller
    // error, not a successful removal of zero instances.
    if (!Type)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("foliage_remove_instances: '%s' did not resolve to a UFoliageType"), *Path));

    int32 Removed = 0;
    {
        if (FFoliageInfo* Info = IFA->FindInfo(Type))
        {
            TArray<int32> ToRemove;
            for (int32 i = 0; i < Info->Instances.Num(); ++i)
            {
                if (Bounds.IsInside(Info->Instances[i].Location))
                    ToRemove.Add(i);
            }
            Removed = ToRemove.Num();
            if (Removed > 0)
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

    TArray<TSharedPtr<FJsonValue>> Types;
    AInstancedFoliageActor* IFA = AInstancedFoliageActor::Get(World, false);
    if (IFA)
    {
        for (const auto& Pair : IFA->GetFoliageInfos())
        {
            UFoliageType* Type = Pair.Key;
            const auto& Info = Pair.Value;
            if (!Type) continue;

            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("path"), Type->GetPathName());
            Entry->SetNumberField(TEXT("count"), Info->Instances.Num());
            Types.Add(MakeShared<FJsonValueObject>(Entry));
        }
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

    int32 Density = 5;
    P->TryGetNumberField(TEXT("density"), Density);
    if (Density <= 0) Density = 1;

    AInstancedFoliageActor* IFA = AInstancedFoliageActor::Get(World, true);
    if (!IFA) return FHaybaHandlerResult::Err(TEXT("foliage_paint_at: cannot get IFA"));

    UFoliageType* Type = ResolveFoliageType(IFA, Path);
    if (!Type) return FHaybaHandlerResult::Err(FString::Printf(TEXT("foliage_paint_at: cannot load foliage type: %s"), *Path));

    // Honesty: the paint loop below builds instances but discards each one — no
    // foliage is actually placed. Reporting painted:<density> for zero real work
    // is a lie, so return a structured error instead of a fabricated count.
    (void)Center; (void)Radius; (void)Density;
    return FHaybaHandlerResult::Err(
        TEXT("foliage_paint_at: not implemented — foliage instance persistence is unavailable "
             "on this engine version; no foliage was painted"));
}
