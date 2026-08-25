#include "HaybaActorOps.h"

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

    /** An actor lookup that admits when it cannot tell which one you meant. */
    struct FActorLookup
    {
        AActor* Actor = nullptr;
        /** Actors whose LABEL matched, when the label was ambiguous. Empty on
         *  a clean hit. */
        TArray<FString> Candidates;
    };

    /**
     * Resolve an actor by unique name, or failing that by label.
     *
     * Labels are NOT unique in UE. This used to return the first match and say
     * nothing, so `actor_delete` on a duplicated label reported
     * {"deleted": true} and destroyed an arbitrary one of several — verified
     * against a live editor, two cubes labelled the same, one silently gone
     * and the caller told it had succeeded.
     *
     * The unique object name is checked first and wins outright, because that
     * is the identifier that can only mean one thing.
     */
    FActorLookup FindActorChecked(UWorld* World, const FString& Name)
    {
        FActorLookup Out;
        if (!World) return Out;

        TArray<AActor*> ByLabel;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetName() == Name)
            {
                // Object names are unique, so this is unambiguous by
                // construction and outranks any label match.
                Out.Actor = *It;
                Out.Candidates.Reset();
                return Out;
            }
            if (It->GetActorLabel() == Name) ByLabel.Add(*It);
        }

        if (ByLabel.Num() == 1)
        {
            Out.Actor = ByLabel[0];
            return Out;
        }
        for (AActor* A : ByLabel) Out.Candidates.Add(A->GetName());
        return Out;
    }

    /** The error a caller gets when a label matched several actors. Names the
     *  unique alternatives, because "be more specific" without saying what to
     *  be specific WITH is not an instruction. */
    FString AmbiguousActorError(const FString& Name, const TArray<FString>& Candidates)
    {
        return FString::Printf(
            TEXT("actor label \"%s\" matches %d actors (%s) — refusing to guess which. ")
            TEXT("Use one of those unique names instead, or rename the actors so the label is unique."),
            *Name, Candidates.Num(), *FString::Join(Candidates, TEXT(", ")));
    }

    AActor* FindActor(UWorld* World, const FString& Name)
    {
        return FindActorChecked(World, Name).Actor;
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

        const FActorLookup Hit = FindActorChecked(EditorWorld(), ActorId);
        if (Hit.Candidates.Num() > 1)
        {
            Res.Error = AmbiguousActorError(ActorId, Hit.Candidates);
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

        const FActorLookup Hit = FindActorChecked(EditorWorld(), Req.ActorId);
        if (Hit.Candidates.Num() > 1)
        {
            Res.Error = AmbiguousActorError(Req.ActorId, Hit.Candidates);
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
