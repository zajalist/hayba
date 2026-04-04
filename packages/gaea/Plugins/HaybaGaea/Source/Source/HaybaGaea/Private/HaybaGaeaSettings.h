#pragma once
#include "CoreMinimal.h"

UENUM()
enum class EHaybaOperationMode : uint8
{
	Integrated,
	ApiKey
};

class FHaybaGaeaSettings
{
public:
	static FHaybaGaeaSettings& Get();

	FString ServerHost = TEXT("127.0.0.1");
	int32 ServerPort = 55558;
	FString HeightmapOutputFolder;

	bool bHasSeenWizard = false;
	EHaybaOperationMode OperationMode = EHaybaOperationMode::Integrated;

	// Shared across plugins — read/written to [HaybaShared] section
	static FString GetSharedApiKey();
	static void SetSharedApiKey(const FString& Key);

	void Load();
	void Save() const;

private:
	static constexpr const TCHAR* Section       = TEXT("HaybaGaea");
	static constexpr const TCHAR* SharedSection = TEXT("HaybaShared");
};
