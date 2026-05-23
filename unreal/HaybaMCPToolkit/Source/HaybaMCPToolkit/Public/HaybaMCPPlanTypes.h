#pragma once
#include "CoreMinimal.h"

// Public so the module can buffer pending plans without including the
// (Private/) SHaybaMCPPlanPanel header. Kept POD on purpose — every field is
// a value type so the struct trivially copies into the module-side buffer
// and out again into the panel.
struct FHaybaPlanStep
{
    int32   Index = 0;
    FString Title;
    FString Description;   // optional explainer
    FString Tool;          // optional: which tool will execute this step

    enum class EStatus : uint8 { Pending, Running, Completed, Failed };
    EStatus Status = EStatus::Pending;

    // Compat shim — old callers set bCompleted / bPending directly.
    bool bCompleted = false;
    bool bPending = true;
};
