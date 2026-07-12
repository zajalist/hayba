#include "HaybaMCPISMHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "Engine/StaticMesh.h"
#include "GameFramework/Actor.h"
#include "Components/InstancedStaticMeshComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPISM, Log, All);

namespace
{
    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static bool ReadVec(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, FVector& Out)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr;
        if (!Obj.IsValid() || !Obj->TryGetArrayField(Field, Arr) || Arr->Num() < 3) return false;
        Out = FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        return true;
    }

    static AActor* FindActorByName(UWorld* World, const FString& Name)
    {
        if (!World) return nullptr;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetName() == Name || It->GetActorLabel() == Name)
                return *It;
        }
        return nullptr;
    }

    static UInstancedStaticMeshComponent* GetISM(AActor* Actor)
    {
        return Actor ? Actor->FindComponentByClass<UInstancedStaticMeshComponent>() : nullptr;
    }

    static FTransform ParseTransform(const TSharedPtr<FJsonObject>& Obj)
    {
        FVector Loc = FVector::ZeroVector;
        FVector RotV = FVector::ZeroVector;
        FVector Scale = FVector::OneVector;
        ReadVec(Obj, TEXT("location"), Loc);
        ReadVec(Obj, TEXT("rotation"), RotV);
        ReadVec(Obj, TEXT("scale"), Scale);
        return FTransform(FRotator(RotV.X, RotV.Y, RotV.Z), Loc, Scale);
    }
}

TArray<FString> FHaybaMCPISMHandler::GetCommands() const
{
    return {
        TEXT("ism_create_actor"),
        TEXT("ism_add_instance"),
        TEXT("ism_add_instances"),
        TEXT("ism_clear_instances"),
    };
}

FHaybaHandlerResult FHaybaMCPISMHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("ism_create_actor"))    return IsmCreateActor(P);
    if (Cmd == TEXT("ism_add_instance"))    return IsmAddInstance(P);
    if (Cmd == TEXT("ism_add_instances"))   return IsmAddInstances(P);
    if (Cmd == TEXT("ism_clear_instances")) return IsmClearInstances(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("ISMHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPISMHandler::IsmCreateActor(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("ism_create_actor: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("ism_create_actor: no editor world"));

    FString MeshPath;
    if (!P->TryGetStringField(TEXT("static_mesh_path"), MeshPath) || MeshPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ism_create_actor: missing static_mesh_path"));

    FString Label;
    if (!P->TryGetStringField(TEXT("label"), Label) || Label.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("ism_create_actor: missing label"));

    FVector Loc = FVector::ZeroVector;
    ReadVec(P, TEXT("location"), Loc);

    UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *MeshPath);
    if (!Mesh) return FHaybaHandlerResult::Err(FString::Printf(TEXT("ism_create_actor: cannot load mesh: %s"), *MeshPath));

    FActorSpawnParameters Sp;
    Sp.Name = MakeUniqueObjectName(World->GetCurrentLevel(), AActor::StaticClass(), FName(*Label));
    AActor* Actor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform(Loc), Sp);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("ism_create_actor: SpawnActor failed"));

    UInstancedStaticMeshComponent* ISM = NewObject<UInstancedStaticMeshComponent>(
        Actor, UInstancedStaticMeshComponent::StaticClass(), TEXT("ISM"));
    Actor->SetRootComponent(ISM);
    ISM->SetStaticMesh(Mesh);
    ISM->RegisterComponent();
    Actor->AddInstanceComponent(ISM);
    Actor->SetActorLabel(Label);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Actor->GetName());
    Out->SetStringField(TEXT("label"), Actor->GetActorLabel());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPISMHandler::IsmAddInstance(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("ism_add_instance: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("ism_add_instance: missing actor_id"));

    const TSharedPtr<FJsonObject>* TransformObj;
    if (!P->TryGetObjectField(TEXT("transform"), TransformObj))
        return FHaybaHandlerResult::Err(TEXT("ism_add_instance: missing transform"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("ism_add_instance: actor not found"));
    UInstancedStaticMeshComponent* ISM = GetISM(Actor);
    if (!ISM) return FHaybaHandlerResult::Err(TEXT("ism_add_instance: no ISM component"));

    int32 Idx = ISM->AddInstance(ParseTransform(*TransformObj));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("instance_index"), Idx);
    Out->SetNumberField(TEXT("total_count"), ISM->GetInstanceCount());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPISMHandler::IsmAddInstances(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("ism_add_instances: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("ism_add_instances: missing actor_id"));

    const TArray<TSharedPtr<FJsonValue>>* Arr;
    if (!P->TryGetArrayField(TEXT("transforms"), Arr))
        return FHaybaHandlerResult::Err(TEXT("ism_add_instances: missing transforms"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("ism_add_instances: actor not found"));
    UInstancedStaticMeshComponent* ISM = GetISM(Actor);
    if (!ISM) return FHaybaHandlerResult::Err(TEXT("ism_add_instances: no ISM component"));

    const int32 Cap = FMath::Min(Arr->Num(), 1000);
    int32 Added = 0;
    for (int32 i = 0; i < Cap; ++i)
    {
        const TSharedPtr<FJsonObject>& Obj = (*Arr)[i]->AsObject();
        if (!Obj.IsValid()) continue;
        ISM->AddInstance(ParseTransform(Obj));
        ++Added;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("added"), Added);
    Out->SetNumberField(TEXT("total_count"), ISM->GetInstanceCount());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPISMHandler::IsmClearInstances(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("ism_clear_instances: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("ism_clear_instances: missing actor_id"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("ism_clear_instances: actor not found"));
    UInstancedStaticMeshComponent* ISM = GetISM(Actor);
    if (!ISM) return FHaybaHandlerResult::Err(TEXT("ism_clear_instances: no ISM component"));

    // Honesty: report how many instances were actually removed so a caller can
    // tell a real clear from a no-op on an already-empty component.
    const int32 RemovedCount = ISM->GetInstanceCount();
    ISM->ClearInstances();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("cleared"), true);
    Out->SetNumberField(TEXT("removed_count"), RemovedCount);
    return FHaybaHandlerResult::Ok(Out);
}
