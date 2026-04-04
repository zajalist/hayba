#pragma once
#include "CoreMinimal.h"

/** GConfig-backed settings for Hayba PCGEx MCP. All fields persist across editor sessions. */
class FPCGExBridgeSettings
{
public:
	static FPCGExBridgeSettings& Get();

	// API key for whichever provider is configured
	FString ApiKey;

	// Base URL — Anthropic by default, swap to any OpenAI-compatible endpoint
	FString BaseURL = TEXT("https://api.anthropic.com/v1/messages");

	// Model ID — interpreted by the target endpoint
	FString Model = TEXT("claude-opus-4-6-20251101");

	// UE content path where generated graphs are saved
	FString OutputPath = TEXT("/Game/PCGExBridge/Generated");

	void Load();
	void Save() const;

	bool HasApiKey() const { return !ApiKey.IsEmpty(); }

	// Returns true when the configured endpoint is Anthropic
	bool IsAnthropicEndpoint() const { return BaseURL.Contains(TEXT("anthropic.com")); }

private:
	static constexpr const TCHAR* Section        = TEXT("HaybaPCGEx");
	static constexpr const TCHAR* KeyApiKey      = TEXT("ApiKey");
	static constexpr const TCHAR* KeyBaseURL     = TEXT("BaseURL");
	static constexpr const TCHAR* KeyModel       = TEXT("Model");
	static constexpr const TCHAR* KeyOutputPath  = TEXT("OutputPath");
};
