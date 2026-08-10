#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPAdvisoryTypes.generated.h"

/**
 * Controls optional guidance in MCP replies. Errors and safety-required
 * recovery instructions are never suppressible.
 */
UENUM()
enum class EHaybaMCPAdvisoryVerbosity : uint8
{
    ErrorsOnly UMETA(DisplayName="Errors only"),
    ErrorsAndWarnings UMETA(DisplayName="Errors and warnings"),
    ErrorsWarningsAndTips UMETA(DisplayName="Errors, warnings, and AI tips")
};
