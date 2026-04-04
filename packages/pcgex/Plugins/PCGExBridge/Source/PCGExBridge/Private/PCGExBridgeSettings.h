#pragma once
#include "CoreMinimal.h"

/** GConfig-backed settings for PCGExBridge. All fields persist across editor sessions. */
class FPCGExBridgeSettings
{
public:
	static FPCGExBridgeSettings& Get();

	// Anthropic API key (stored in EditorPerProjectUserSettings.ini)
	FString ApiKey;

	// Claude model to use for graph generation
	FString Model = TEXT("claude-opus-4-6-20251101");

	// UE content path where generated graphs are saved
	FString OutputPath = TEXT("/Game/PCGExBridge/Generated");

	void Load();
	void Save() const;

	bool HasApiKey() const { return !ApiKey.IsEmpty(); }

private:
	static constexpr const TCHAR* Section     = TEXT("PCGExBridge");
	static constexpr const TCHAR* KeyApiKey   = TEXT("ApiKey");
	static constexpr const TCHAR* KeyModel    = TEXT("Model");
	static constexpr const TCHAR* KeyOutputPath = TEXT("OutputPath");
};
