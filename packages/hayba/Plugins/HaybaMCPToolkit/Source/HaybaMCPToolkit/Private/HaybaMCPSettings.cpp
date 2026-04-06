#include "HaybaMCPSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"

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
    GConfig->GetString(Section, KeyApiKey,     ApiKey,      GEditorPerProjectIni);
    GConfig->GetString(Section, KeyBaseURL,    BaseURL,     GEditorPerProjectIni);
    GConfig->GetString(Section, KeyModel,      Model,       GEditorPerProjectIni);
    GConfig->GetString(Section, KeyOutputPath, OutputPath,  GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("ConventionsScope"), ConventionsScope, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->GetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);

    FString ModeStr;
    GConfig->GetString(Section, TEXT("OperationMode"), ModeStr, GEditorPerProjectIni);
    OperationMode = (ModeStr == TEXT("ApiKey")) ? EHaybaMCPOperationMode::ApiKey : EHaybaMCPOperationMode::Integrated;

    if (BaseURL.IsEmpty())             BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
    if (Model.IsEmpty())               Model      = TEXT("claude-opus-4-6-20251101");
    if (OutputPath.IsEmpty())          OutputPath = TEXT("/Game/PCGExBridge/Generated");
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
    GConfig->SetString(Section, TEXT("ConventionsScope"), *ConventionsScope, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bConfirmBeforeOverwrite"), bConfirmBeforeOverwrite, GEditorPerProjectIni);
    GConfig->SetInt(Section, TEXT("PreferredLandscapeResolution"), PreferredLandscapeResolution, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("OperationMode"),
        OperationMode == EHaybaMCPOperationMode::ApiKey ? TEXT("ApiKey") : TEXT("Integrated"),
        GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}
