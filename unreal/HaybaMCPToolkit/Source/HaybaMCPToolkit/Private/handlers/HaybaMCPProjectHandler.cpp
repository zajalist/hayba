#include "HaybaMCPProjectHandler.h"

#include "GeneralProjectSettings.h"
#include "Interfaces/IProjectManager.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "Misc/EngineVersion.h"
#include "Misc/ConfigCacheIni.h"
#include "ProjectDescriptor.h"
#include "EngineUtils.h"
#include "Editor.h"
#include "Engine/Engine.h"

TArray<FString> FHaybaMCPProjectHandler::GetCommands() const
{
    return {
        TEXT("project_get_info"),
        TEXT("project_get_settings"),
        TEXT("project_set_settings"),
        TEXT("project_list_plugins")
    };
}

static TSharedRef<FJsonObject> GetInfo()
{
    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("project_name"),  FApp::GetProjectName());
    Out->SetStringField(TEXT("project_dir"),   FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
    Out->SetStringField(TEXT("content_dir"),   FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir()));
    Out->SetStringField(TEXT("saved_dir"),     FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir()));
    Out->SetStringField(TEXT("engine_version"),FEngineVersion::Current().ToString());
    Out->SetStringField(TEXT("session_id"),    FApp::GetSessionName());
    if (const FProjectDescriptor* Desc = IProjectManager::Get().GetCurrentProject())
    {
        Out->SetStringField(TEXT("engine_association"), Desc->EngineAssociation);
        Out->SetStringField(TEXT("description"),        Desc->Description);
        Out->SetStringField(TEXT("category"),           Desc->Category);
    }
    return Out;
}

static TSharedRef<FJsonObject> GetSettings()
{
    auto Out = MakeShared<FJsonObject>();
    if (const UGeneralProjectSettings* GP = GetDefault<UGeneralProjectSettings>())
    {
        Out->SetStringField(TEXT("project_id"),         GP->ProjectID.ToString());
        Out->SetStringField(TEXT("project_name"),       GP->ProjectName);
        Out->SetStringField(TEXT("project_version"),    GP->ProjectVersion);
        Out->SetStringField(TEXT("company_name"),       GP->CompanyName);
        Out->SetStringField(TEXT("homepage"),           GP->Homepage);
        Out->SetStringField(TEXT("support_contact"),    GP->SupportContact);
        Out->SetStringField(TEXT("description"),        GP->Description);
        Out->SetStringField(TEXT("copyright_notice"),   GP->CopyrightNotice);
    }
    // Default map / startup map come from a separate section.
    FString DefaultMap;
    GConfig->GetString(TEXT("/Script/EngineSettings.GameMapsSettings"), TEXT("EditorStartupMap"), DefaultMap, GEngineIni);
    Out->SetStringField(TEXT("editor_startup_map"), DefaultMap);
    return Out;
}

// Returns an error string when nothing was written, empty otherwise. The two
// failure cases used to be reported as an `error` field inside an Ok response —
// a caller checking `ok` was told a settings write succeeded when not one key
// had been touched.
static FHaybaHandlerResult SetSetting(const TSharedPtr<FJsonObject>& Params)
{
    auto Out = MakeShared<FJsonObject>();
    if (!Params.IsValid())
    {
        return FHaybaHandlerResult::Err(TEXT("project_set_settings: no params object was supplied"));
    }

    // Generic passthrough: explicit section/key/value into a chosen ini.
    FString Section, Key, Value;
    if (Params->TryGetStringField(TEXT("section"), Section)
        && Params->TryGetStringField(TEXT("key"),  Key)
        && Params->TryGetStringField(TEXT("value"),Value))
    {
        GConfig->SetString(*Section, *Key, *Value, GEngineIni);
        GConfig->Flush(false, GEngineIni);
        Out->SetBoolField(TEXT("ok"), true);
        Out->SetStringField(TEXT("section"), Section);
        Out->SetStringField(TEXT("key"),     Key);
        return FHaybaHandlerResult::Ok(Out);
    }

    // Typed: write GeneralProjectSettings fields to GGameIni (DefaultGame.ini).
    static const TCHAR* GPSection = TEXT("/Script/EngineSettings.GeneralProjectSettings");
    TArray<TSharedPtr<FJsonValue>> Updated;
    auto Apply = [&](const TCHAR* Field, const TCHAR* IniKey)
    {
        FString V;
        if (Params->TryGetStringField(Field, V))
        {
            GConfig->SetString(GPSection, IniKey, *V, GGameIni);
            Updated.Add(MakeShared<FJsonValueString>(Field));
        }
    };
    Apply(TEXT("project_name"),                TEXT("ProjectName"));
    Apply(TEXT("company_name"),                TEXT("CompanyName"));
    Apply(TEXT("description"),                 TEXT("Description"));
    Apply(TEXT("homepage"),                    TEXT("Homepage"));
    Apply(TEXT("project_version"),             TEXT("ProjectVersion"));
    Apply(TEXT("company_distinguished_name"),  TEXT("CompanyDistinguishedName"));
    Apply(TEXT("project_id"),                  TEXT("ProjectID"));
    Apply(TEXT("support_contact"),             TEXT("SupportContact"));
    Apply(TEXT("copyright_notice"),            TEXT("CopyrightNotice"));

    if (Updated.Num() == 0)
    {
        // Nothing recognised is a caller error, not a successful no-op. Name the
        // fields that exist so the next attempt can be right.
        return FHaybaHandlerResult::Err(TEXT(
            "project_set_settings: nothing was written — no recognized field was supplied. "
            "Pass section+key+value to write an ini key directly, or one or more of: "
            "project_name, company_name, description, homepage, project_version, "
            "company_distinguished_name, project_id, support_contact, copyright_notice."));
    }
    GConfig->Flush(false, GGameIni);
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetArrayField(TEXT("updated"), Updated);
    return FHaybaHandlerResult::Ok(Out);
}

static TSharedRef<FJsonObject> ListPlugins()
{
    auto Out = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> PluginsJson;
    for (const TSharedRef<IPlugin>& P : IPluginManager::Get().GetEnabledPlugins())
    {
        const FPluginDescriptor& D = P->GetDescriptor();
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),          P->GetName());
        Entry->SetStringField(TEXT("friendly_name"), D.FriendlyName);
        Entry->SetNumberField(TEXT("version"),       D.Version);
        Entry->SetStringField(TEXT("version_name"),  D.VersionName);
        Entry->SetBoolField  (TEXT("enabled"),       P->IsEnabled());
        Entry->SetStringField(TEXT("category"),      D.Category);
        Entry->SetStringField(TEXT("description"),   D.Description);
        Entry->SetBoolField  (TEXT("is_engine"),     P->GetType() == EPluginType::Engine);
        PluginsJson.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Out->SetArrayField(TEXT("plugins"), PluginsJson);
    Out->SetNumberField(TEXT("count"),  PluginsJson.Num());
    return Out;
}

FHaybaHandlerResult FHaybaMCPProjectHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("project_get_info"))     return FHaybaHandlerResult::Ok(GetInfo());
    if (Cmd == TEXT("project_get_settings")) return FHaybaHandlerResult::Ok(GetSettings());
    if (Cmd == TEXT("project_set_settings")) return SetSetting(Params);
    if (Cmd == TEXT("project_list_plugins")) return FHaybaHandlerResult::Ok(ListPlugins());
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("ProjectHandler: unknown command %s"), *Cmd));
}
