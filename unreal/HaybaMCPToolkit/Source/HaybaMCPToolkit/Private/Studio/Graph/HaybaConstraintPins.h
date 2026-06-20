#pragma once
#include "CoreMinimal.h"

// Typed pin categories for the constraint graph. Declared extern (external
// linkage) so the node + schema translation units share one definition.
namespace HaybaPin
{
    extern const FName Region;     // a mask region
    extern const FName Geometry;   // the asset's baked geometry
    extern const FName Result;     // a constraint result
    extern const FName Flow;       // gate -> verdict
}
