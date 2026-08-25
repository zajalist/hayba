#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;

/**
 * One actor lookup, with uniform semantics about what "found" means.
 *
 * Actor labels are NOT unique in UE. Every handler that resolved one used to
 * walk the world and return the first match, which meant a command targeting a
 * duplicated label acted on an arbitrary actor and said nothing. For
 * actor_delete that was verified to destroy the wrong cube and report
 * {"deleted": true}; for a read it is the same ambiguity, reporting one
 * actor's properties as though it were the only candidate.
 *
 * The unique object name is checked first and wins outright, because that is
 * the identifier that can only mean one thing.
 */
namespace HaybaSceneQuery
{
    struct FActorLookup
    {
        AActor* Actor = nullptr;
        /** Unique names of the actors whose LABEL matched, when more than one
         *  did. Empty on a clean hit — so `Candidates.Num() > 1` is the
         *  ambiguity test, and callers do not have to invent their own. */
        TArray<FString> Candidates;

        bool IsAmbiguous() const { return Candidates.Num() > 1; }
    };

    /** Resolve by unique object name, else by label. */
    FActorLookup FindActor(UWorld* World, const FString& NameOrLabel);

    /** The error text for an ambiguous label. Names the unique alternatives,
     *  because "be more specific" without saying what to be specific WITH is
     *  not an instruction. */
    FString AmbiguousError(const FString& Command, const FString& NameOrLabel,
                           const TArray<FString>& Candidates);
}
