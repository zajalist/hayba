// The SP-1 solver: cost/energy minimization over candidate bonds. A bond's cost
// is the sum of its two directional requirement checks. A satisfied direction
// costs 0; an unsatisfied Require-All term costs RelaxablePenalty if the requiring
// socket is relaxable (downgrade -> a logged seam) else HardPenalty (+inf); an
// Exclude hit always costs HardPenalty. Pick the lowest-cost candidate. This one
// mechanism is scoring + bias + the substrate for repair (spec §3.2). Pure.
#pragma once

#include "CoreMinimal.h"
#include "pcg/HaybaSocketContract.h"

struct FHaybaBondOutcome
{
    bool   bOk          = false;       // a bond was committed (clean or relaxed)
    bool   bRelaxed     = false;       // committed only by downgrading a relaxable requirement
    int32  ChosenIndex  = INDEX_NONE;  // index into the candidate array
    double Cost         = 0.0;

    // Unsat-core payload — populated when !bOk OR bRelaxed (the offending direction):
    FName           RequirerName;      // the socket whose Require-All term failed
    FName           ProviderName;      // the neighbor that failed to provide it
    TArray<FString> MissingRequired;   // the unmet Require-All tags
    TArray<FString> NeighborProvided;  // provider's sorted expanded provides
};

namespace HaybaSocketSolver
{
    constexpr double HardPenalty      = 1e30;
    constexpr double RelaxablePenalty = 1000.0;

    // One directional check: does Provider satisfy Requirer's requirements?
    // Returns the cost contribution and, on failure, the offending detail.
    struct FDirCost
    {
        double          Cost = 0.0;
        bool            bRelaxedHere = false;
        TArray<FString> Missing;       // unmet Require-All tags
        bool            bExcludeHit = false;
    };

    inline FDirCost ScoreDirection(const FHaybaSocketContract& Requirer, const FHaybaSocketContract& Provider)
    {
        FDirCost D;
        const FHaybaRequireResult R = HaybaSocketContract::Evaluate(Requirer.Requires, Provider.Provides);
        if (R.HitExcluded.Num() > 0)
        {
            D.Cost = HardPenalty;
            D.bExcludeHit = true;
            return D;
        }
        if (R.MissingRequired.Num() > 0)
        {
            D.Missing = R.MissingRequired;
            if (Requirer.bRelaxable)
            {
                D.Cost = RelaxablePenalty * R.MissingRequired.Num();
                D.bRelaxedHere = true;
            }
            else
            {
                D.Cost = HardPenalty;
            }
        }
        return D;
    }

    // Solve one frontier against its candidates; pick the lowest-cost bond.
    inline FHaybaBondOutcome SolveBond(const FHaybaSocketContract& Frontier, TArrayView<const FHaybaSocketContract> Candidates)
    {
        FHaybaBondOutcome Best;
        Best.Cost = HardPenalty * 4.0; // sentinel above any single-bond cost

        for (int32 i = 0; i < Candidates.Num(); ++i)
        {
            const FHaybaSocketContract& Cand = Candidates[i];
            const FDirCost FwdDir = ScoreDirection(Frontier, Cand); // frontier requires of candidate
            const FDirCost RevDir = ScoreDirection(Cand, Frontier); // candidate requires of frontier
            const double   Total  = FMath::Min(FwdDir.Cost + RevDir.Cost, HardPenalty * 4.0);

            if (Total < Best.Cost)
            {
                Best = FHaybaBondOutcome{};
                Best.ChosenIndex = i;
                Best.Cost        = Total;
                Best.bOk         = Total < HardPenalty;
                Best.bRelaxed    = Best.bOk && Total >= RelaxablePenalty;

                // Capture the offending direction for the unsat-core (forward first, else reverse).
                const bool bFwdOffends = (FwdDir.Cost > 0.0);
                const FDirCost& Off = bFwdOffends ? FwdDir : RevDir;
                if (Off.Cost > 0.0)
                {
                    const FHaybaSocketContract& Req = bFwdOffends ? Frontier : Cand;
                    const FHaybaSocketContract& Prv = bFwdOffends ? Cand : Frontier;
                    Best.RequirerName     = Req.Name;
                    Best.ProviderName     = Prv.Name;
                    Best.MissingRequired  = Off.Missing;
                    Best.NeighborProvided = HaybaSocketContract::SortedExpandedProvides(Prv.Provides);
                }
            }
        }
        return Best;
    }
}
