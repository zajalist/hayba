#include "HaybaMCPSettings.h"
#include "HaybaMCPDeveloperSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "HAL/FileManager.h"

FHaybaMCPSettings& FHaybaMCPSettings::Get()
{
    static FHaybaMCPSettings Instance;
    return Instance;
}

FString FHaybaMCPSettings::GetSharedApiKey()
{
    FString Key;
    GConfig->GetString(SharedSection, KeyApiKey, Key, GEditorPerProjectIni);
    return Key;
}

void FHaybaMCPSettings::SetSharedApiKey(const FString& Key)
{
    GConfig->SetString(SharedSection, KeyApiKey, *Key, GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}

void FHaybaMCPSettings::Load()
{
    if (const UHaybaMCPDeveloperSettings* DevSettings = GetDefault<UHaybaMCPDeveloperSettings>())
    {
        CapabilityToken          = DevSettings->CapabilityToken;
        bEnableExecutionJournal  = DevSettings->bEnableExecutionJournal;
        bAllowUnsafePython       = DevSettings->bAllowUnsafePython;
        RateLimitPerMinute       = DevSettings->RateLimitPerMinute;
        bCodeModeEnabled         = DevSettings->bCodeModeEnabled;
        ToolCacheTTLSeconds      = DevSettings->ToolCacheTTLSeconds;
        SidecarURL               = DevSettings->SidecarURL;
        ModelPreset              = (int32)DevSettings->ModelPreset;
        bEnableSpatialCLIP       = DevSettings->bEnableSpatialCLIP;
        bEnableOWLViT            = DevSettings->bEnableOWLViT;
        bEnableContinuousCapture = DevSettings->bEnableContinuousCapture;
    }

    GConfig->GetString(Section, KeyApiKey,     ApiKey,      GEditorPerProjectIni);
    GConfig->GetString(Section, KeyBaseURL,    BaseURL,     GEditorPerProjectIni);
    GConfig->GetString(Section, KeyModel,      Model,       GEditorPerProjectIni);
    GConfig->GetString(Section, KeyOutputPath, OutputPath,  GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenOnboarding"), bHasSeenOnboarding, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bPlanModeEnabled"), bPlanModeEnabled, GEditorPerProjectIni);
    GConfig->GetInt(Section, TEXT("PlanModeToolCallCount"), PlanModeToolCallCount, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bShownPlanModePrompt"), bShownPlanModePrompt, GEditorPerProjectIni);
    {
        FString DateStr;
        if (GConfig->GetString(Section, TEXT("PlanModeFirstUseDate"), DateStr, GEditorPerProjectIni) && !DateStr.IsEmpty())
            FDateTime::ParseIso8601(*DateStr, PlanModeFirstUseDate);
    }
    GConfig->GetString(Section, TEXT("ConventionsScope"), ConventionsScope, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->GetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);

    FString ModeStr;
    GConfig->GetString(Section, TEXT("OperationMode"), ModeStr, GEditorPerProjectIni);
    OperationMode = (ModeStr == TEXT("ApiKey")) ? EHaybaMCPOperationMode::ApiKey : EHaybaMCPOperationMode::Integrated;

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
    GConfig->SetString(Section, KeyApiKey,     *ApiKey,      GEditorPerProjectIni);
    GConfig->SetString(Section, KeyBaseURL,    *BaseURL,     GEditorPerProjectIni);
    GConfig->SetString(Section, KeyModel,      *Model,       GEditorPerProjectIni);
    GConfig->SetString(Section, KeyOutputPath, *OutputPath,  GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("HeightmapOutputFolder"), *HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bHasSeenOnboarding"), bHasSeenOnboarding, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bPlanModeEnabled"), bPlanModeEnabled, GEditorPerProjectIni);
    GConfig->SetInt(Section, TEXT("PlanModeToolCallCount"), PlanModeToolCallCount, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bShownPlanModePrompt"), bShownPlanModePrompt, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("PlanModeFirstUseDate"), *PlanModeFirstUseDate.ToIso8601(), GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("ConventionsScope"), *ConventionsScope, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->SetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("OperationMode"),
        OperationMode == EHaybaMCPOperationMode::ApiKey ? TEXT("ApiKey") : TEXT("Integrated"),
        GEditorPerProjectIni);

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
    Json += TEXT("\n  ]\n}\n");
    FFileHelper::SaveStringToFile(Json, *FilePath);
}
