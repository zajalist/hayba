#pragma once
#include "CoreMinimal.h"

class FHaybaGaeaLandscapeImporter
{
public:
	/**
	 * Create an ALandscape actor in the current level from a heightmap PNG/R16 file.
	 * Must be called on the game thread.
	 * @return true if the landscape actor was created successfully.
	 */
	static bool ImportHeightmap(const FString& HeightmapPath);
};
