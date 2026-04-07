#pragma once
#include "CoreMinimal.h"

struct FHaybaMCPImportParams
{
    FString HeightmapPath;
    float   WorldSizeKm       = 8.0f;
    float   MaxHeightM        = 600.0f;
    FString LandscapeMaterial;          // empty = no material assigned
    FString ActorLabel        = TEXT("Hayba_Terrain");
};

class FHaybaMCPLandscapeImporter
{
public:
    /**
     * Create an ALandscape actor in the current level from a heightmap PNG/R16 file.
     * Computes scale using Gaea2Unreal formulas:
     *   ScaleXY = WorldSizeKm * 1000 * 100 / Resolution
     *   ScaleZ  = MaxHeightM * 100 / 512
     * Must be called on the game thread.
     * @return true if the landscape actor was created successfully.
     */
    static bool ImportHeightmap(const FHaybaMCPImportParams& Params);
};
