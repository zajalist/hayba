#include "HaybaActorOps.h"

#include "HaybaSceneQuery.h"

#include "Editor.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Subsystems/EditorActorSubsystem.h"

namespace
{
    UEditorActorSubsystem* ActorSubsystem()
    {
        return GEditor ? GEditor->GetEditorSubsystem<UEditorActorSubsystem>() : nullptr;
    }

    UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    AActor* FindActor(UWorld* World, const FString& Name)
    {
        return HaybaSceneQuery::FindActor(World, Name).Actor;
    }
}

namespace HaybaActorOps
{
    // ── Parse ────────────────────────────────────────────────────────────────

    FSpawnRequest ParseSpawn(FHaybaParamReader& R)
    {
        FSpawnRequest Req;
        Req.ClassPath = R.RequiredString(TEXT("class_path"));
        if (const TOptional<FVector> Loc = R.OptionalVec3(TEXT("location")); Loc.IsSet())
        {
            Req.Location = *Loc;
        }
        if (const TOptional<FRotator> Rot = R.OptionalRotator(TEXT("rotation")); Rot.IsSet())
        {
            Req.Rotation = *Rot;
        }
        Req.Scale = R.OptionalVec3(TEXT("scale"));
        Req.Label = R.OptionalString(TEXT("label"));
        return Req;
    }

    FTransformRequest ParseTransform(FHaybaParamReader& R)
    {
        FTransformRequest Req;
        Req.ActorId  = R.RequiredString(TEXT("actor_id"));
        Req.Location = R.OptionalVec3(TEXT("location"));
        Req.Rotation = R.OptionalRotator(TEXT("rotation"));
        Req.Scale    = R.OptionalVec3(TEXT("scale"));
        if (!Req.HasAnything())
        {
            // Reporting ok for a call that changed nothing is the failure mode
            // this codebase keeps rediscovering. Say so at the door.
            R.AddError(TEXT("nothing to apply — pass at least one of location, rotation, scale"));
        }
        return Req;
    }

    // ── Execute ──────────────────────────────────────────────────────────────

    FSpawnResult Spawn(const FSpawnRequest& Req)
    {
        FSpawnResult Res;

        UClass* ActorClass = LoadClass<AActor>(nullptr, *Req.ClassPath);
        if (!ActorClass)
        {
            Res.Error = FString::Printf(TEXT("class not found: %s"), *Req.ClassPath);
            return Res;
        }

        UEditorActorSubsystem* EAS = ActorSubsystem();
        if (!EAS)
        {
            Res.Error = TEXT("EditorActorSubsystem unavailable");
            return Res;
        }

        AActor* NewActor = EAS->SpawnActorFromClass(ActorClass, Req.Location, Req.Rotation);
        if (!NewActor)
        {
            Res.Error = TEXT("SpawnActorFromClass failed");
            return Res;
        }

        if (Req.Scale.IsSet())  NewActor->SetActorScale3D(*Req.Scale);
        if (!Req.Label.IsEmpty()) NewActor->SetActorLabel(Req.Label);

        Res.bOk       = true;
        Res.ActorId   = NewActor->GetName();
        Res.Label     = NewActor->GetActorLabel();
        Res.ClassName = ActorClass->GetName();
        return Res;
    }

    FDeleteResult Delete(const FString& ActorId)
    {
        FDeleteResult Res;

        const HaybaSceneQuery::FActorLookup Hit = HaybaSceneQuery::FindActor(EditorWorld(), ActorId);
        if (Hit.IsAmbiguous())
        {
            Res.Error = HaybaSceneQuery::AmbiguousError(TEXT("actor_delete"), ActorId, Hit.Candidates);
            return Res;
        }
        AActor* Actor = Hit.Actor;
        if (!Actor)
        {
            Res.Error = FString::Printf(TEXT("actor not found: %s"), *ActorId);
            return Res;
        }

        UEditorActorSubsystem* EAS = ActorSubsystem();
        if (!EAS)
        {
            Res.Error = TEXT("EditorActorSubsystem unavailable");
            return Res;
        }

        // DestroyActor can return false — actor locked, world protected — while
        // the actor is still there. Never report a delete that did not happen.
        if (!EAS->DestroyActor(Actor))
        {
            Res.Error = FString::Printf(
                TEXT("DestroyActor failed for %s (actor may be locked or non-destructible)"), *ActorId);
            return Res;
        }

        Res.bOk = true;
        return Res;
    }

    FTransformResult Transform(const FTransformRequest& Req)
    {
        FTransformResult Res;

        const HaybaSceneQuery::FActorLookup Hit = HaybaSceneQuery::FindActor(EditorWorld(), Req.ActorId);
        if (Hit.IsAmbiguous())
        {
            Res.Error = HaybaSceneQuery::AmbiguousError(TEXT("actor_transform"), Req.ActorId, Hit.Candidates);
            return Res;
        }
        AActor* Actor = Hit.Actor;
        if (!Actor)
        {
            Res.Error = FString::Printf(TEXT("actor not found: %s"), *Req.ActorId);
            return Res;
        }

        if (Req.Location.IsSet())
        {
            Actor->SetActorLocation(*Req.Location);
            Res.AppliedKeys.Add(TEXT("location"));
        }
        if (Req.Rotation.IsSet())
        {
            Actor->SetActorRotation(*Req.Rotation);
            Res.AppliedKeys.Add(TEXT("rotation"));
        }
        if (Req.Scale.IsSet())
        {
            Actor->SetActorScale3D(*Req.Scale);
            Res.AppliedKeys.Add(TEXT("scale"));
        }

        // Read back rather than echoing the request: the engine can clamp or
        // refuse a value, and reporting what we asked for would hide that.
        Res.bOk      = true;
        Res.Location = Actor->GetActorLocation();
        Res.Rotation = Actor->GetActorRotation();
        Res.Scale    = Actor->GetActorScale3D();
        return Res;
    }
}
