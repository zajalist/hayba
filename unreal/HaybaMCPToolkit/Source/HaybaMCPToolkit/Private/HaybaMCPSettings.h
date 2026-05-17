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
    FString OutputPath = TEXT("/Game/Hayba/Generated");

    // Gaea heightmap output folder (from HaybaGaea)
    FString HeightmapOutputFolder;

    // Conventions
    FString ConventionsScope = TEXT("global");
    bool bConfirmBeforeOverwrite = true;
    int32 PreferredLandscapeResolution = 1009;

    bool bHasSeenWizard = false;
    EHaybaMCPOperationMode OperationMode = EHaybaMCPOperationMode::Integrated;

    // Onboarding (new branching wizard, separate from legacy bHasSeenWizard)
    bool bHasSeenOnboarding = false;

    // Plan Mode — safety toggle. ON by default for first 7 days / 50 tool calls.
    bool bPlanModeEnabled = true;
    FDateTime PlanModeFirstUseDate;
    int32 PlanModeToolCallCount = 0;
    bool bShownPlanModePrompt = false;

    // Security
    // Optional. When set, every TCP request must include matching `auth` field.
    FString CapabilityToken;
    // Append every command execution to Saved/hayba-execution.log.
    bool bEnableExecutionJournal = true;
    // Allow Tier 3 Python scripts (filesystem, subprocess, socket).
    bool bAllowUnsafePython = false;

    // Mirrored from UHaybaMCPDeveloperSettings (Project Settings UI)
    int32 RateLimitPerMinute = 60;
    bool bCodeModeEnabled = true;
    float ToolCacheTTLSeconds = 2.0f;
    FString SidecarURL = TEXT("http://localhost:7821");
    int32 ModelPreset = 0;       // 0=Minimal, 1=Balanced, 2=Full
    bool bEnableSpatialCLIP = false;
    bool bEnableOWLViT = false;
    bool bEnableContinuousCapture = false;

    // Accessibility — user-controlled UI scale multiplier applied to the
    // whole Hayba panel via SDPIScaler. 1.0 = stock, range typically 0.85–1.5.
    float UIScale = 1.0f;

    // Scene Map renderer pick. Auto chooses Web on modern GPUs, Native on
    // low-end / headless contexts. Users can force one or the other.
    enum class ESceneMapRenderer : uint8 { Auto = 0, Native = 1, Web = 2 };
    ESceneMapRenderer SceneMapRenderer = ESceneMapRenderer::Auto;

    // MCP capability gating — tools listed here are hidden from the agent
    // (filtered out of list_tool_categories / get_tool_signature) and rejected
    // with a `tool_disabled` error when called. Drives the MCP panel.
    TSet<FString> DisabledTools;
    // Written to Saved/HaybaMCP/disabled-tools.json on every Save(); the Node
    // MCP server watches this file and rebuilds its disabled set from it.
    void WriteDisabledToolsFile() const;

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
