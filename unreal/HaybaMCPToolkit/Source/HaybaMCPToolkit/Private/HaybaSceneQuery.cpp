#include "HaybaSceneQuery.h"

#include "EngineUtils.h"
#include "GameFramework/Actor.h"

namespace HaybaSceneQuery
{
    FActorLookup FindActor(UWorld* World, const FString& NameOrLabel)
    {
        FActorLookup Out;
        if (!World) return Out;

        TArray<AActor*> ByLabel;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetName() == NameOrLabel)
            {
                // Object names are unique, so this is unambiguous by
                // construction and outranks any label match. Returning here
                // also means a label that happens to equal another actor's
                // object name cannot make an exact hit look contested.
                Out.Actor = *It;
                Out.Candidates.Reset();
                return Out;
            }
            if (It->GetActorLabel() == NameOrLabel) ByLabel.Add(*It);
        }

        if (ByLabel.Num() == 1)
        {
            Out.Actor = ByLabel[0];
            return Out;
        }

        // Zero matches leaves Actor null with no candidates: "not found".
        // Two or more leaves Actor null WITH candidates: "cannot tell which".
        // Those are different answers and callers should give different errors.
        for (AActor* A : ByLabel) Out.Candidates.Add(A->GetName());
        return Out;
    }

    FString AmbiguousError(const FString& Command, const FString& NameOrLabel,
                           const TArray<FString>& Candidates)
    {
        return FString::Printf(
            TEXT("%s: actor label \"%s\" matches %d actors (%s) — refusing to guess which. ")
            TEXT("Use one of those unique names instead, or rename the actors so the label is unique."),
            *Command, *NameOrLabel, Candidates.Num(), *FString::Join(Candidates, TEXT(", ")));
    }
}
