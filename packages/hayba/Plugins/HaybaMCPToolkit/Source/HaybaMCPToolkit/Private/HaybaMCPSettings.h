#pragma once
#include "CoreMinimal.h"

UENUM()
enum class EHaybaMCPOperationMode : uint8
{
    Integrated,
    ApiKey
};

class FHaybaMCPSettings
{
public:
    static FHaybaMCPSettings& Get();

    // Claude API settings
    FString ApiKey;
    FString BaseURL = TEXT("https://api.anthropic.com/v1/messages");
    FString Model = TEXT("claude-opus-4-6-20251101");

    // PCGEx output
    FString OutputPath = TEXT("/Game/PCGExBridge/Generated");

    // Gaea heightmap output folder (from HaybaGaea)
    FString HeightmapOutputFolder;

    bool bHasSeenWizard = false;
    EHaybaMCPOperationMode OperationMode = EHaybaMCPOperationMode::Integrated;

    static FString GetSharedApiKey();
    static void SetSharedApiKey(const FString& Key);

    void Load();
    void Save() const;

    bool HasApiKey() const { return !GetSharedApiKey().IsEmpty(); }
    bool IsAnthropicEndpoint() const { return BaseURL.Contains(TEXT("anthropic.com")); }

private:
    static constexpr const TCHAR* Section       = TEXT("HaybaMCPToolkit");
    static constexpr const TCHAR* SharedSection = TEXT("HaybaShared");
    static constexpr const TCHAR* KeyApiKey     = TEXT("ApiKey");
    static constexpr const TCHAR* KeyBaseURL    = TEXT("BaseURL");
    static constexpr const TCHAR* KeyModel      = TEXT("Model");
    static constexpr const TCHAR* KeyOutputPath = TEXT("OutputPath");
};
