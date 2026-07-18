#pragma once
#include "CoreMinimal.h"

// ── BYOK provider catalog mirror ────────────────────────────────────────────
// MIRROR of mcp-tools/hayba-mcp/src/agents/providers.ts (Task 1 catalog).
// There is NO build-time codegen linking the two — this is a DOCUMENTED MANUAL
// MIRROR. If you add/edit/remove a provider in providers.ts you MUST make the
// same change in the GetProviderCatalog() array in HaybaMCPSettings.cpp, and
// vice-versa. Fields map 1:1 to ProviderEntry (id/label/baseURLDefault/
// defaultModel/needsKey/keyHint); `protocol` is not needed C++-side.
struct FHaybaProviderInfo
{
    const TCHAR* Id;
    const TCHAR* Label;
    const TCHAR* BaseURLDefault;
    const TCHAR* DefaultModel;
    bool         bNeedsKey;
    const TCHAR* KeyHint;
};

class FHaybaMCPSettings
{
public:
    static FHaybaMCPSettings& Get();

    // Claude / LLM API settings.
    // ApiKey is a transient in-memory scratch value only (e.g. the Settings panel
    // stages a freshly-typed key here before handing it to the vault). It is NOT
    // loaded from or persisted to disk — the key of record lives DPAPI-encrypted
    // in the vault via Get/SetProviderKey. Treat as sensitive: never log/journal.
    FString ApiKey;
    FString BaseURL = TEXT("https://api.anthropic.com/v1/messages");
    FString Model = TEXT("claude-opus-4-6-20251101");

    // BYOK — id of the currently-selected provider (matches a catalog entry id).
    // The vault stores one encrypted key per provider id; this picks which one
    // the chat client / GetSharedApiKey resolves.
    FString SelectedProviderId = TEXT("anthropic");

    // PCGEx output
    FString OutputPath = TEXT("/Game/Hayba/Generated");

    // Gaea heightmap output folder (from HaybaGaea)
    FString HeightmapOutputFolder;

    // Conventions
    FString ConventionsScope = TEXT("global");
    bool bConfirmBeforeOverwrite = true;
    int32 PreferredLandscapeResolution = 1009;

    bool bHasSeenWizard = false;

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
    // Auto-start the Node chat sidecar at editor startup (on the SidecarURL port)
    // when nothing is already listening there. TRUE by default so the in-editor
    // chat "just works" with no manual step.
    bool bAutoStartSidecar = true;
    // Optional override for the sidecar server entry .js. When non-empty and the
    // file exists it wins over the auto-resolved dev / bundled build paths.
    FString SidecarEntryPath = TEXT("");
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

    // Legacy single-key accessors. Retained for the in-editor chat client;
    // now route through the DPAPI vault under the currently-selected provider id.
    static FString GetSharedApiKey();
    static void SetSharedApiKey(const FString& Key);

    // ── DPAPI-encrypted BYOK key vault ──────────────────────────────────────
    // Keys are stored as DPAPI ciphertext (hex) in GEditorPerProjectIni under
    // [HaybaProviderKeys], keyed by provider id — never plaintext. Decrypted on
    // demand. On Windows this uses CryptProtectData/CryptUnprotectData (per-user,
    // per-machine). DPAPI is Windows-only; other platforms fall back to a weak
    // XOR+Base64 obfuscation (NOT secure) — documented limitation matching the
    // plugin's Win64 pinning.
    static void    SetProviderKey(const FString& ProviderId, const FString& Plaintext);
    static FString GetProviderKey(const FString& ProviderId);   // -> plaintext ("" if none / decrypt fail)
    static void    ClearProviderKey(const FString& ProviderId);
    static FString GetProviderKeyLast4(const FString& ProviderId); // masked, safe to display/log
    static bool    HasProviderKey(const FString& ProviderId);

    // Catalog mirror of providers.ts. See FHaybaProviderInfo doc above.
    static const TArray<FHaybaProviderInfo>& GetProviderCatalog();
    static const FHaybaProviderInfo* FindProvider(const FString& ProviderId);

    void Load();
    void Save() const;

    bool HasApiKey() const { return !GetSharedApiKey().IsEmpty(); }
    bool IsAnthropicEndpoint() const { return BaseURL.Contains(TEXT("anthropic.com")); }

private:
    static constexpr const TCHAR* Section       = TEXT("HaybaMCPToolkit");
    static constexpr const TCHAR* SharedSection = TEXT("HaybaShared");
    // Ciphertext (DPAPI hex) lives here, one entry per provider id.
    static constexpr const TCHAR* VaultSection  = TEXT("HaybaProviderKeys");
    static constexpr const TCHAR* KeyApiKey     = TEXT("ApiKey");
    static constexpr const TCHAR* KeyBaseURL    = TEXT("BaseURL");
    static constexpr const TCHAR* KeyModel      = TEXT("Model");
    static constexpr const TCHAR* KeyOutputPath = TEXT("OutputPath");
};
