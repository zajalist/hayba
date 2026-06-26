// A socket contract: what a connection point PROVIDES (dotted tags) and what it
// REQUIRES of a neighbor (Require-All conjunction + Exclude list). Compatibility
// is Boolean set-intersection over expanded-ancestor tag sets (spec §5). Pure.
#pragma once

#include "CoreMinimal.h"
#include "pcg/HaybaTag.h"

struct FHaybaRequire
{
    TArray<FString> All;     // every tag here must be provided by the neighbor
    TArray<FString> Exclude; // none of these may be provided by the neighbor
};

struct FHaybaSocketContract
{
    FName            Name;
    TArray<FString>  Provides;
    FHaybaRequire    Requires;
    FString          Polarity;          // "male"/"female"/"" — recorded, not gated in SP-1
    double           CostWeight = 1.0;  // soft weight (reserved; cost is 0/penalty in SP-1)
    bool             bRelaxable = true; // a hard Require-All miss may be downgraded
};

struct FHaybaRequireResult
{
    bool            bSatisfied = false;
    TArray<FString> MissingRequired; // Require-All tags the neighbor does not provide
    TArray<FString> HitExcluded;     // Exclude tags the neighbor wrongly provides
};

namespace HaybaSocketContract
{
    // Evaluate Req against a neighbor's RAW provides (expanded internally).
    inline FHaybaRequireResult Evaluate(const FHaybaRequire& Req, const TArray<FString>& NeighborProvides)
    {
        const TSet<FString> Expanded = HaybaTag::ExpandAll(NeighborProvides);
        FHaybaRequireResult R;
        for (const FString& Need : Req.All)
        {
            if (!HaybaTag::Provides(Expanded, Need))
            {
                R.MissingRequired.Add(Need);
            }
        }
        for (const FString& Ban : Req.Exclude)
        {
            if (HaybaTag::Provides(Expanded, Ban))
            {
                R.HitExcluded.Add(Ban);
            }
        }
        R.bSatisfied = (R.MissingRequired.Num() == 0) && (R.HitExcluded.Num() == 0);
        return R;
    }

    // Stable, de-duplicated, ascending expansion — used for human-readable reports.
    inline TArray<FString> SortedExpandedProvides(const TArray<FString>& Provides)
    {
        TArray<FString> Out = HaybaTag::ExpandAll(Provides).Array();
        Out.Sort(); // FString::operator< — lexicographic, deterministic
        return Out;
    }
}
