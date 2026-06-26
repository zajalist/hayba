// Renders a bond outcome to (a) a one-line human string for the viewport overlay
// and (b) .scratch/unsat-core.json — the deterministic test oracle for the moat.
#pragma once

#include "CoreMinimal.h"

struct FHaybaBondOutcome;

namespace HaybaUnsatCore
{
    FString BuildHuman(const FHaybaBondOutcome& O);
    FString ResolvePath();
    bool    Write(const FHaybaBondOutcome& O, const FName& Frontier, const FName& Candidate,
                  const FString& Path, FString& OutError);
}
