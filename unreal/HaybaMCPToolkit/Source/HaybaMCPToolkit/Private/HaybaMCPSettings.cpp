#include "HaybaMCPSettings.h"
#include "HaybaMCPDeveloperSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Misc/Base64.h"
#include "HAL/FileManager.h"

// File-local log category. Used only for redacted vault failures — the key
// plaintext is NEVER passed to any UE_LOG call in this file.
DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPVault, Log, All);

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <wincrypt.h>
#include "Windows/HideWindowsPlatformTypes.h"
#endif

FHaybaMCPSettings& FHaybaMCPSettings::Get()
{
    static FHaybaMCPSettings Instance;
    return Instance;
}

// ── Provider catalog mirror (see FHaybaProviderInfo doc / providers.ts) ──────
const TArray<FHaybaProviderInfo>& FHaybaMCPSettings::GetProviderCatalog()
{
    // MIRROR of mcp-tools/hayba-mcp/src/agents/providers.ts. Keep in sync by
    // hand — there is no codegen. Order matches the TS PROVIDERS array.
    static const TArray<FHaybaProviderInfo> Catalog = {
        { TEXT("mock"),       TEXT("Mock (offline, no key)"),        TEXT(""),                                 TEXT("mock"),                       false, TEXT("(no key)") },
        { TEXT("anthropic"),  TEXT("Anthropic"),                     TEXT("https://api.anthropic.com"),        TEXT("claude-opus-4-8"),            true,  TEXT("sk-ant-...") },
        { TEXT("openai"),     TEXT("OpenAI"),                        TEXT("https://api.openai.com/v1"),        TEXT("gpt-4o-mini"),                true,  TEXT("sk-...") },
        { TEXT("groq"),       TEXT("Groq (free tier)"),              TEXT("https://api.groq.com/openai/v1"),   TEXT("llama-3.3-70b-versatile"),    true,  TEXT("gsk_...") },
        { TEXT("openrouter"), TEXT("OpenRouter (free routes)"),      TEXT("https://openrouter.ai/api/v1"),     TEXT(""),                           true,  TEXT("sk-or-...") },
        { TEXT("ollama"),     TEXT("Ollama (local)"),                TEXT("http://localhost:11434/v1"),        TEXT("qwen2.5-coder:7b-instruct"),  false, TEXT("(no key)") },
        { TEXT("lmstudio"),   TEXT("LM Studio (local)"),             TEXT("http://localhost:1234/v1"),         TEXT("local-model"),                false, TEXT("(no key)") },
        { TEXT("custom"),     TEXT("Custom OpenAI-compatible"),      TEXT(""),                                 TEXT(""),                           false, TEXT("optional") },
    };
    return Catalog;
}

const FHaybaProviderInfo* FHaybaMCPSettings::FindProvider(const FString& ProviderId)
{
    for (const FHaybaProviderInfo& P : GetProviderCatalog())
    {
        if (ProviderId.Equals(P.Id, ESearchCase::IgnoreCase)) return &P;
    }
    return nullptr;
}

// ── DPAPI encrypt/decrypt helpers ────────────────────────────────────────────
namespace
{
    // Weak fallback obfuscation key for non-Windows platforms only. This is NOT
    // cryptographic protection — it exists so the vault format round-trips on
    // platforms without DPAPI. The plugin is Win64-pinned so this path is
    // effectively dead in shipping.
    const uint8 kFallbackXor[] = { 0x48, 0x61, 0x79, 0x62, 0x61, 0x4D, 0x43, 0x50 }; // "HaybaMCP"

    // Encrypt plaintext -> opaque hex string. Empty in -> empty out.
    bool EncryptToHex(const FString& Plain, FString& OutHex)
    {
        OutHex.Reset();
        if (Plain.IsEmpty()) return true;

        // UTF-8 encode the plaintext.
        FTCHARToUTF8 Utf8(*Plain);
        const int32 NumBytes = Utf8.Length();

#if PLATFORM_WINDOWS
        DATA_BLOB In;
        In.cbData = (DWORD)NumBytes;
        In.pbData = (BYTE*)(const ANSICHAR*)Utf8.Get(); // CryptProtectData does not modify input
        DATA_BLOB Out;
        Out.cbData = 0;
        Out.pbData = nullptr;
        if (!CryptProtectData(&In, L"HaybaMCP BYOK key", nullptr, nullptr, nullptr,
                              CRYPTPROTECT_UI_FORBIDDEN, &Out))
        {
            return false;
        }
        OutHex = BytesToHex(Out.pbData, (int32)Out.cbData);
        LocalFree(Out.pbData); // DATA_BLOB.pbData is owned by us, free with LocalFree
        return true;
#else
        // Fallback: XOR + Base64 (NOT secure). Marked with an 'F:' prefix so
        // decrypt can distinguish it from DPAPI hex.
        TArray<uint8> Bytes;
        Bytes.Append((const uint8*)(const ANSICHAR*)Utf8.Get(), NumBytes);
        for (int32 i = 0; i < Bytes.Num(); ++i)
            Bytes[i] ^= kFallbackXor[i % UE_ARRAY_COUNT(kFallbackXor)];
        OutHex = TEXT("F:") + FBase64::Encode(Bytes);
        return true;
#endif
    }

    // Decrypt hex string -> plaintext. Empty in -> empty out.
    bool DecryptFromHex(const FString& Stored, FString& OutPlain)
    {
        OutPlain.Reset();
        if (Stored.IsEmpty()) return true;

        if (Stored.StartsWith(TEXT("F:")))
        {
            // Fallback-obfuscated payload (written on a non-Windows host).
            TArray<uint8> Bytes;
            if (!FBase64::Decode(Stored.RightChop(2), Bytes)) return false;
            for (int32 i = 0; i < Bytes.Num(); ++i)
                Bytes[i] ^= kFallbackXor[i % UE_ARRAY_COUNT(kFallbackXor)];
            auto Conv = StringCast<TCHAR>((const UTF8CHAR*)Bytes.GetData(), Bytes.Num());
            OutPlain = FString(Conv.Length(), Conv.Get());
            return true;
        }

#if PLATFORM_WINDOWS
        TArray<uint8> Cipher;
        Cipher.SetNumUninitialized(Stored.Len() / 2);
        HexToBytes(Stored, Cipher.GetData());
        DATA_BLOB In;
        In.cbData = (DWORD)Cipher.Num();
        In.pbData = Cipher.GetData();
        DATA_BLOB Out;
        Out.cbData = 0;
        Out.pbData = nullptr;
        if (!CryptUnprotectData(&In, nullptr, nullptr, nullptr, nullptr,
                                CRYPTPROTECT_UI_FORBIDDEN, &Out))
        {
            return false;
        }
        {
            auto Conv = StringCast<TCHAR>((const UTF8CHAR*)Out.pbData, (int32)Out.cbData);
            OutPlain = FString(Conv.Length(), Conv.Get());
        }
        LocalFree(Out.pbData);
        return true;
#else
        // Non-fallback ciphertext on a non-Windows host is undecryptable.
        return false;
#endif
    }
}

void FHaybaMCPSettings::SetProviderKey(const FString& ProviderId, const FString& Plaintext)
{
    if (ProviderId.IsEmpty()) return;
    if (Plaintext.IsEmpty())
    {
        ClearProviderKey(ProviderId);
        return;
    }
    FString Hex;
    if (!EncryptToHex(Plaintext, Hex))
    {
        // NEVER log the plaintext. Only the failure + provider id.
        UE_LOG(LogHaybaMCPVault, Warning, TEXT("SetProviderKey: DPAPI encrypt failed for provider '%s' — key NOT stored."), *ProviderId);
        return;
    }
    GConfig->SetString(VaultSection, *ProviderId, *Hex, GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}

FString FHaybaMCPSettings::GetProviderKey(const FString& ProviderId)
{
    if (ProviderId.IsEmpty()) return FString();
    FString Hex;
    if (!GConfig->GetString(VaultSection, *ProviderId, Hex, GEditorPerProjectIni) || Hex.IsEmpty())
        return FString();
    FString Plain;
    if (!DecryptFromHex(Hex, Plain))
    {
        UE_LOG(LogHaybaMCPVault, Warning, TEXT("GetProviderKey: DPAPI decrypt failed for provider '%s' (wrong user/machine?)."), *ProviderId);
        return FString();
    }
    return Plain;
}

void FHaybaMCPSettings::ClearProviderKey(const FString& ProviderId)
{
    if (ProviderId.IsEmpty()) return;
    GConfig->RemoveKey(VaultSection, *ProviderId, GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}

FString FHaybaMCPSettings::GetProviderKeyLast4(const FString& ProviderId)
{
    const FString Plain = GetProviderKey(ProviderId);
    if (Plain.IsEmpty()) return FString();
    return (Plain.Len() <= 4) ? Plain : Plain.Right(4);
}

bool FHaybaMCPSettings::HasProviderKey(const FString& ProviderId)
{
    if (ProviderId.IsEmpty()) return false;
    FString Hex;
    return GConfig->GetString(VaultSection, *ProviderId, Hex, GEditorPerProjectIni) && !Hex.IsEmpty();
}

FString FHaybaMCPSettings::GetSharedApiKey()
{
    // Route the legacy single-key path through the vault under the selected provider.
    return GetProviderKey(Get().SelectedProviderId);
}

void FHaybaMCPSettings::SetSharedApiKey(const FString& Key)
{
    SetProviderKey(Get().SelectedProviderId, Key);
}

void FHaybaMCPSettings::Load()
{
    if (const UHaybaMCPDeveloperSettings* DevSettings = GetDefault<UHaybaMCPDeveloperSettings>())
    {
        CapabilityToken          = DevSettings->CapabilityToken;
        bEnableExecutionJournal  = DevSettings->bEnableExecutionJournal;
        RateLimitPerMinute       = DevSettings->RateLimitPerMinute;
        // Clamp again at the runtime boundary. UPROPERTY clamps protect the UI,
        // but an edited config file must not turn a safety ceiling into an
        // allocation or queue-amplification primitive.
        TcpMaxRequestBytes       = FMath::Clamp(DevSettings->TcpMaxRequestBytes, 64 * 1024, 16 * 1024 * 1024);
        TcpMaxResponseBytes      = FMath::Clamp(DevSettings->TcpMaxResponseBytes, 1024 * 1024, 64 * 1024 * 1024);
        TcpMaxClientConnections = FMath::Clamp(DevSettings->TcpMaxClientConnections, 1, 64);
        TcpMaxPendingCommands    = FMath::Clamp(DevSettings->TcpMaxPendingCommands, 1, 1024);
        TcpMaxJsonNestingDepth   = FMath::Clamp(DevSettings->TcpMaxJsonNestingDepth, 8, 256);
        TcpFrameReadTimeoutMs    = FMath::Clamp(DevSettings->TcpFrameReadTimeoutMs, 500, 30000);
        TcpSendTimeoutMs         = FMath::Clamp(DevSettings->TcpSendTimeoutMs, 100, 30000);
        bCodeModeEnabled         = DevSettings->bCodeModeEnabled;
        AdvisoryVerbosity        = DevSettings->AdvisoryVerbosity;
        ToolCacheTTLSeconds      = DevSettings->ToolCacheTTLSeconds;
        SidecarURL               = DevSettings->SidecarURL;
        ModelPreset              = (int32)DevSettings->ModelPreset;
        bEnableSpatialCLIP       = DevSettings->bEnableSpatialCLIP;
        bEnableOWLViT            = DevSettings->bEnableOWLViT;
        bEnableContinuousCapture = DevSettings->bEnableContinuousCapture;
    }

    GConfig->GetString(Section, TEXT("SelectedProviderId"), SelectedProviderId, GEditorPerProjectIni);
    if (SelectedProviderId.IsEmpty()) SelectedProviderId = TEXT("anthropic");

    // One-time migration: earlier builds stored the LLM key in PLAINTEXT under
    // [HaybaShared] ApiKey. If that legacy value exists and the vault has no key
    // for the selected provider yet, re-encrypt it into the DPAPI vault and wipe
    // the plaintext so it never lingers on disk.
    {
        FString LegacyPlain;
        if (GConfig->GetString(SharedSection, KeyApiKey, LegacyPlain, GEditorPerProjectIni) && !LegacyPlain.IsEmpty())
        {
            if (!HasProviderKey(SelectedProviderId))
                SetProviderKey(SelectedProviderId, LegacyPlain);
            GConfig->RemoveKey(SharedSection, KeyApiKey, GEditorPerProjectIni);
            GConfig->Flush(false, GEditorPerProjectIni);
        }
    }
    // Legacy plaintext key under [HaybaMCPToolkit] ApiKey is likewise removed
    // (never decrypted into a variable that could be logged). Do NOT read it back.
    {
        FString LegacyPlain2;
        if (GConfig->GetString(Section, KeyApiKey, LegacyPlain2, GEditorPerProjectIni) && !LegacyPlain2.IsEmpty())
        {
            if (!HasProviderKey(SelectedProviderId))
                SetProviderKey(SelectedProviderId, LegacyPlain2);
            GConfig->RemoveKey(Section, KeyApiKey, GEditorPerProjectIni);
            GConfig->Flush(false, GEditorPerProjectIni);
        }
    }

    GConfig->GetString(Section, KeyBaseURL,    BaseURL,     GEditorPerProjectIni);
    GConfig->GetString(Section, KeyModel,      Model,       GEditorPerProjectIni);
    GConfig->GetString(Section, KeyOutputPath, OutputPath,  GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenOnboarding"), bHasSeenOnboarding, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bPlanModeEnabled"), bPlanModeEnabled, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bPlanApprovalStrictConsume"), bPlanApprovalStrictConsume, GEditorPerProjectIni);
    GConfig->GetInt(Section, TEXT("PlanModeToolCallCount"), PlanModeToolCallCount, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bShownPlanModePrompt"), bShownPlanModePrompt, GEditorPerProjectIni);
    {
        FString DateStr;
        if (GConfig->GetString(Section, TEXT("PlanModeFirstUseDate"), DateStr, GEditorPerProjectIni) && !DateStr.IsEmpty())
            FDateTime::ParseIso8601(*DateStr, PlanModeFirstUseDate);
    }
    GConfig->GetBool(Section, TEXT("bAutoStartSidecar"), bAutoStartSidecar, GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("SidecarEntryPath"), SidecarEntryPath, GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("ConventionsScope"), ConventionsScope, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->GetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);

    {
        FString RenderStr;
        if (GConfig->GetString(Section, TEXT("SceneMapRenderer"), RenderStr, GEditorPerProjectIni))
        {
            if      (RenderStr == TEXT("Native")) SceneMapRenderer = ESceneMapRenderer::Native;
            else if (RenderStr == TEXT("Web"))    SceneMapRenderer = ESceneMapRenderer::Web;
            else                                  SceneMapRenderer = ESceneMapRenderer::Auto;
        }
    }

    DisabledTools.Empty();
    FString DisabledJoined;
    if (GConfig->GetString(Section, TEXT("DisabledTools"), DisabledJoined, GEditorPerProjectIni) && !DisabledJoined.IsEmpty())
    {
        TArray<FString> Names;
        DisabledJoined.ParseIntoArray(Names, TEXT(","), true);
        for (const FString& N : Names) if (!N.IsEmpty()) DisabledTools.Add(N);
    }

    if (BaseURL.IsEmpty())             BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
    if (Model.IsEmpty())               Model      = TEXT("claude-opus-4-6-20251101");
    if (OutputPath.IsEmpty())          OutputPath = TEXT("/Game/Hayba/Generated");
    if (HeightmapOutputFolder.IsEmpty())
        HeightmapOutputFolder = FPaths::ProjectSavedDir() / TEXT("HaybaGaea");
}

void FHaybaMCPSettings::Save() const
{
    // Keep the custom in-plugin panel and Project Settings on one source of
    // truth. The custom panel edits this cached model; UDeveloperSettings owns
    // the persisted Config property used on the next editor launch.
    if (UHaybaMCPDeveloperSettings* DevSettings = GetMutableDefault<UHaybaMCPDeveloperSettings>())
    {
        if (DevSettings->AdvisoryVerbosity != AdvisoryVerbosity)
        {
            DevSettings->AdvisoryVerbosity = AdvisoryVerbosity;
            DevSettings->SaveConfig();
        }
    }

    // NOTE: the LLM API key is NOT written here — it lives DPAPI-encrypted in the
    // vault ([HaybaProviderKeys]) via SetProviderKey. Never persist it plaintext.
    GConfig->SetString(Section, TEXT("SelectedProviderId"), *SelectedProviderId, GEditorPerProjectIni);
    GConfig->SetString(Section, KeyBaseURL,    *BaseURL,     GEditorPerProjectIni);
    GConfig->SetString(Section, KeyModel,      *Model,       GEditorPerProjectIni);
    GConfig->SetString(Section, KeyOutputPath, *OutputPath,  GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("HeightmapOutputFolder"), *HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bHasSeenOnboarding"), bHasSeenOnboarding, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bPlanModeEnabled"), bPlanModeEnabled, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bPlanApprovalStrictConsume"), bPlanApprovalStrictConsume, GEditorPerProjectIni);
    GConfig->SetInt(Section, TEXT("PlanModeToolCallCount"), PlanModeToolCallCount, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bShownPlanModePrompt"), bShownPlanModePrompt, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("PlanModeFirstUseDate"), *PlanModeFirstUseDate.ToIso8601(), GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bAutoStartSidecar"), bAutoStartSidecar, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("SidecarEntryPath"), *SidecarEntryPath, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("ConventionsScope"), *ConventionsScope, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->SetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);

    {
        const TCHAR* Name = TEXT("Auto");
        if (SceneMapRenderer == ESceneMapRenderer::Native) Name = TEXT("Native");
        else if (SceneMapRenderer == ESceneMapRenderer::Web) Name = TEXT("Web");
        GConfig->SetString(Section, TEXT("SceneMapRenderer"), Name, GEditorPerProjectIni);
    }

    // DisabledTools — stored as a comma-joined string in .ini and mirrored
    // to a JSON file the Node MCP server watches.
    {
        TArray<FString> Sorted = DisabledTools.Array();
        Sorted.Sort();
        const FString Joined = FString::Join(Sorted, TEXT(","));
        GConfig->SetString(Section, TEXT("DisabledTools"), *Joined, GEditorPerProjectIni);
    }

    GConfig->Flush(false, GEditorPerProjectIni);
    WriteDisabledToolsFile();
}

void FHaybaMCPSettings::WriteDisabledToolsFile() const
{
    const FString Dir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("HaybaMCP"));
    IFileManager::Get().MakeDirectory(*Dir, true);
    const FString FilePath = FPaths::Combine(Dir, TEXT("disabled-tools.json"));

    TArray<FString> Sorted = DisabledTools.Array();
    Sorted.Sort();
    FString Json = TEXT("{\n  \"disabled\": [");
    for (int32 i = 0; i < Sorted.Num(); ++i)
    {
        Json += TEXT("\n    \"") + Sorted[i] + TEXT("\"");
        if (i + 1 < Sorted.Num()) Json += TEXT(",");
    }
    Json += FString::Printf(
        TEXT("\n  ],\n  \"advisory_verbosity\": \"%s\"\n}\n"),
        AdvisoryVerbosityWireName(AdvisoryVerbosity));
    FFileHelper::SaveStringToFile(Json, *FilePath);
}

const TCHAR* FHaybaMCPSettings::AdvisoryVerbosityWireName(
    EHaybaMCPAdvisoryVerbosity Value)
{
    switch (Value)
    {
    case EHaybaMCPAdvisoryVerbosity::ErrorsOnly:
        return TEXT("errors_only");
    case EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips:
        return TEXT("errors_warnings_and_tips");
    case EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings:
    default:
        return TEXT("errors_and_warnings");
    }
}
