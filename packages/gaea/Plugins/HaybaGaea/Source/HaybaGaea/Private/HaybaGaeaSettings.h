#pragma once
#include "CoreMinimal.h"

class FHaybaGaeaSettings
{
public:
	static FHaybaGaeaSettings& Get();

	FString ServerHost = TEXT("127.0.0.1");
	int32 ServerPort = 55558;
	FString HeightmapOutputFolder;

	void Load();
	void Save() const;

private:
	static constexpr const TCHAR* Section = TEXT("HaybaGaea");
};
