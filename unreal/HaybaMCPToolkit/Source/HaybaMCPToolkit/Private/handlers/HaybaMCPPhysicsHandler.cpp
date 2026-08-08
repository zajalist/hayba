#include "HaybaMCPPhysicsHandler.h"
#include "HaybaMCPParams.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Components/PrimitiveComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPPhysics, Log, All);

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

    static UPrimitiveComponent* ResolvePrim(AActor* Actor, const FString& ComponentName)
    {
        if (!Actor) return nullptr;
        if (!ComponentName.IsEmpty())
        {
            for (UActorComponent* C : Actor->GetComponents())
            {
                if (C && C->GetName() == ComponentName)
                {
                    if (UPrimitiveComponent* Prim = Cast<UPrimitiveComponent>(C))
                        return Prim;
                }
            }
            return nullptr;
        }
        if (UPrimitiveComponent* Root = Cast<UPrimitiveComponent>(Actor->GetRootComponent()))
            return Root;
        return Actor->FindComponentByClass<UPrimitiveComponent>();
    }
}

TArray<FString> FHaybaMCPPhysicsHandler::GetCommands() const
{
    return {
        TEXT("physics_set_simulate"),
        TEXT("physics_set_collision_profile"),
        TEXT("physics_add_impulse"),
    };
}

FHaybaHandlerResult FHaybaMCPPhysicsHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("physics_set_simulate"))          return PhysicsSetSimulate(P);
    if (Cmd == TEXT("physics_set_collision_profile")) return PhysicsSetCollisionProfile(P);
    if (Cmd == TEXT("physics_add_impulse"))           return PhysicsAddImpulse(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("PhysicsHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPPhysicsHandler::PhysicsSetSimulate(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("physics_set_simulate: no editor world"));

    FString ActorId;
    FHaybaParamReader ParamR(P, TEXT("physics_set_simulate"));
    ActorId = ParamR.RequiredString(TEXT("actor_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    bool bEnabled = false;
    if (!P->TryGetBoolField(TEXT("enabled"), bEnabled))
        return FHaybaHandlerResult::Err(TEXT("physics_set_simulate: missing enabled"));

    FString ComponentName;
    P->TryGetStringField(TEXT("component_name"), ComponentName);

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("physics_set_simulate: actor not found"));
    UPrimitiveComponent* Prim = ResolvePrim(Actor, ComponentName);
    if (!Prim) return FHaybaHandlerResult::Err(TEXT("physics_set_simulate: no primitive component"));

    Prim->SetSimulatePhysics(bEnabled);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Actor->GetName());
    Out->SetBoolField(TEXT("simulating"), Prim->IsSimulatingPhysics());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPhysicsHandler::PhysicsSetCollisionProfile(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: no editor world"));

    FString ActorId;
    FHaybaParamReader ParamR(P, TEXT("physics_set_collision_profile"));
    ActorId = ParamR.RequiredString(TEXT("actor_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    FString Profile;
    if (!P->TryGetStringField(TEXT("profile_name"), Profile) || Profile.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: missing profile_name"));

    FString ComponentName;
    P->TryGetStringField(TEXT("component_name"), ComponentName);

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: actor not found"));
    UPrimitiveComponent* Prim = ResolvePrim(Actor, ComponentName);
    if (!Prim) return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: no primitive component"));

    Prim->SetCollisionProfileName(FName(*Profile));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("profile"), Profile);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPPhysicsHandler::PhysicsAddImpulse(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: no editor world"));

    FString ActorId;
    FHaybaParamReader ParamR(P, TEXT("physics_add_impulse"));
    ActorId = ParamR.RequiredString(TEXT("actor_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    FVector Impulse;
    if (!ReadVec(P, TEXT("impulse"), Impulse))
        return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: missing impulse"));

    bool bVelocityChange = false;
    P->TryGetBoolField(TEXT("velocity_change"), bVelocityChange);

    FString ComponentName;
    P->TryGetStringField(TEXT("component_name"), ComponentName);

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: actor not found"));
    UPrimitiveComponent* Prim = ResolvePrim(Actor, ComponentName);
    if (!Prim) return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: no primitive component"));

    Prim->AddImpulse(Impulse, NAME_None, bVelocityChange);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("applied"), true);
    return FHaybaHandlerResult::Ok(Out);
}
