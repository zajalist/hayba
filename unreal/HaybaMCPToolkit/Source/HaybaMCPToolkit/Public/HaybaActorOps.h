#pragma once

// The actor domain, with the wire format taken out of it.
//
// Every handler in this plugin takes TSharedPtr<FJsonObject> in and returns
// FJsonObject out, so JSON parsing, UE object lifecycle and response shaping all
// live in one function. Change the wire format and you edit UE code; move to a
// new engine version and you edit wire-format code. Neither half can be tested
// without the other.
//
// This splits the actor domain into three pieces with a seam between each:
//
//   1. Parse   — TSharedPtr<FJsonObject> -> a typed request struct. PURE. No
//                GEditor, no UWorld, no engine state. Testable in isolation,
//                which is the point: parameter handling is where most of the
//                bugs are and it needed a live editor to exercise.
//   2. Execute — request struct -> result struct. Touches the editor, returns
//                data rather than JSON.
//   3. Shape   — result struct -> FJsonObject. Lives in the handler.
//
// Only step 2 needs an editor. Steps 1 and 3 are ordinary code.
//
// The pattern is deliberately small and copyable; see #320 for the other 32
// handler domains.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPParams.h"

namespace HaybaActorOps
{
    // ── Requests (what the caller asked for) ─────────────────────────────────

    struct FSpawnRequest
    {
        FString   ClassPath;
        FVector   Location = FVector::ZeroVector;
        FRotator  Rotation = FRotator::ZeroRotator;
        /** Unset means "leave the class default alone" — distinct from 1,1,1,
         *  which is an explicit instruction that happens to match it. */
        TOptional<FVector> Scale;
        FString   Label;
    };

    struct FTransformRequest
    {
        FString   ActorId;
        TOptional<FVector>  Location;
        TOptional<FRotator> Rotation;
        TOptional<FVector>  Scale;
        /** Nothing to do is a caller error, not a no-op success: a transform
         *  command that changed nothing and reported ok is indistinguishable
         *  from one that silently failed. */
        bool HasAnything() const { return Location.IsSet() || Rotation.IsSet() || Scale.IsSet(); }
    };

    // ── Results (what happened) ──────────────────────────────────────────────

    struct FSpawnResult
    {
        bool    bOk = false;
        FString Error;
        FString ActorId;
        FString Label;
        FString ClassName;
    };

    struct FDeleteResult
    {
        bool    bOk = false;
        FString Error;
    };

    struct FTransformResult
    {
        bool    bOk = false;
        FString Error;
        /** Which of location/rotation/scale were actually written. The old
         *  handler returned a bare ok; a caller could not tell an applied
         *  transform from an ignored one. */
        TArray<FString> AppliedKeys;
        FVector  Location = FVector::ZeroVector;
        FRotator Rotation = FRotator::ZeroRotator;
        FVector  Scale    = FVector::OneVector;
    };

    // ── 1. Parse — pure, no engine state ─────────────────────────────────────

    /** Reads a spawn request. Errors accumulate on the reader; check
     *  R.HasErrors() before executing. */
    FSpawnRequest ParseSpawn(FHaybaParamReader& R);

    /** Reads a transform request. Adds an error if no component was supplied. */
    FTransformRequest ParseTransform(FHaybaParamReader& R);

    // ── 2. Execute — needs a live editor ─────────────────────────────────────

    FSpawnResult     Spawn(const FSpawnRequest& Req);
    FDeleteResult    Delete(const FString& ActorId);
    FTransformResult Transform(const FTransformRequest& Req);
}
