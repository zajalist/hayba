#include "HaybaMCPPhysicsHandler.h"
#include "HaybaSceneQuery.h"
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

    /** Resolve for a MUTATING command: returns null and fills OutError when the
     *  label names more than one actor, rather than acting on whichever came
     *  first out of the iterator. */
    static AActor* FindActorOrAmbiguityError(UWorld* World, const FString& Name,
                                             const TCHAR* Command, FString& OutError)
    {
        const HaybaSceneQuery::FActorLookup Hit = HaybaSceneQuery::FindActor(World, Name);
        if (Hit.IsAmbiguous())
        {
            OutError = HaybaSceneQuery::AmbiguousError(Command, Name, Hit.Candidates);
            return nullptr;
        }
        return Hit.Actor;
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

    FString AmbiguityError;
    AActor* Actor = FindActorOrAmbiguityError(World, ActorId, TEXT("physics_set_simulate"), AmbiguityError);
    if (!AmbiguityError.IsEmpty()) return FHaybaHandlerResult::Err(AmbiguityError);
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

    FString AmbiguityError;
    AActor* Actor = FindActorOrAmbiguityError(World, ActorId, TEXT("physics_set_collision_profile"), AmbiguityError);
    if (!AmbiguityError.IsEmpty()) return FHaybaHandlerResult::Err(AmbiguityError);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: actor not found"));
    UPrimitiveComponent* Prim = ResolvePrim(Actor, ComponentName);
    if (!Prim) return FHaybaHandlerResult::Err(TEXT("physics_set_collision_profile: no primitive component"));

    Prim->SetCollisionProfileName(FName(*Profile));

    // Read the profile back rather than echoing the request. An unrecognised
    // profile name leaves the component on whatever it had, and the old reply —
    // the requested name, unconditionally — was indistinguishable from success.
    const FString Applied = Prim->GetCollisionProfileName().ToString();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("component"), Prim->GetName());
    Out->SetStringField(TEXT("requested_profile"), Profile);
    Out->SetStringField(TEXT("profile"), Applied);
    if (!Applied.Equals(Profile, ESearchCase::IgnoreCase))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("physics_set_collision_profile: '%s' is not a known collision profile — the component is still on '%s'. "
                 "Profiles come from the project's Collision settings (DefaultEngine.ini), e.g. BlockAll, OverlapAll, NoCollision, Pawn."),
            *Profile, *Applied));
    }
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

    FString AmbiguityError;
    AActor* Actor = FindActorOrAmbiguityError(World, ActorId, TEXT("physics_add_impulse"), AmbiguityError);
    if (!AmbiguityError.IsEmpty()) return FHaybaHandlerResult::Err(AmbiguityError);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: actor not found"));
    UPrimitiveComponent* Prim = ResolvePrim(Actor, ComponentName);
    if (!Prim) return FHaybaHandlerResult::Err(TEXT("physics_add_impulse: no primitive component"));

    // An impulse on a component that is not simulating physics is discarded by
    // the engine without complaint. `applied: true` was therefore true of the
    // call and false of the world — the shape this codebase keeps getting bitten
    // by. Refuse instead, and say what to do about it.
    if (!Prim->IsSimulatingPhysics())
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("physics_add_impulse: '%s' on '%s' is not simulating physics, so an impulse would be discarded. "
                 "Call physics_set_simulate with enabled:true first."),
            *Prim->GetName(), *Actor->GetName()));
    }

    Prim->AddImpulse(Impulse, NAME_None, bVelocityChange);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("applied"), true);
    Out->SetStringField(TEXT("component"), Prim->GetName());
    // The resulting velocity is the observable effect; a caller can compare it
    // against what it asked for instead of trusting a bare boolean.
    const FVector V = Prim->GetPhysicsLinearVelocity();
    TSharedPtr<FJsonObject> Vel = MakeShared<FJsonObject>();
    Vel->SetNumberField(TEXT("x"), V.X);
    Vel->SetNumberField(TEXT("y"), V.Y);
    Vel->SetNumberField(TEXT("z"), V.Z);
    Out->SetObjectField(TEXT("linear_velocity_after"), Vel);
    return FHaybaHandlerResult::Ok(Out);
}
