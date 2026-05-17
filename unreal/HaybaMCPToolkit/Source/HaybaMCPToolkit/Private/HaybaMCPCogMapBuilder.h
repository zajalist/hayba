// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCogMapBuilder.h
//
// Builds the cognitive map cells for the Scene Map panel and the
// level_get_spatial_index command (spec §3.2). Two strategies:
//
//   • World Partition cells (primary) — each loaded cell becomes one
//     FHaybaCogMapCell; actor stats accumulated from the cell's runtime
//     actor collection.
//   • Uniform grid (fallback) — bin actors by XY into an NxN grid, drop
//     empty cells, keep ones with at least one non-system actor.
//
// In both cases each cell ends up with a semantic label derived from a
// name→semantic mapping table applied to the dominant class names.

#pragma once
#include "CoreMinimal.h"
#include "HaybaMCPSceneMapData.h"

class UWorld;

namespace HaybaCogMap
{
    /** Build the cell list for the active editor world. */
    TArray<FHaybaCogMapCell> BuildForWorld(UWorld* World);
}
