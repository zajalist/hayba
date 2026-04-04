#include "PCGExBridgeSettings.h"
#include "Misc/ConfigCacheIni.h"

FPCGExBridgeSettings& FPCGExBridgeSettings::Get()
{
	static FPCGExBridgeSettings Instance;
	return Instance;
}

void FPCGExBridgeSettings::Load()
{
	GConfig->GetString(Section, KeyApiKey,     ApiKey,      GEditorPerProjectIni);
	GConfig->GetString(Section, KeyBaseURL,    BaseURL,     GEditorPerProjectIni);
	GConfig->GetString(Section, KeyModel,      Model,       GEditorPerProjectIni);
	GConfig->GetString(Section, KeyOutputPath, OutputPath,  GEditorPerProjectIni);

	if (BaseURL.IsEmpty())    BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
	if (Model.IsEmpty())      Model      = TEXT("claude-opus-4-6-20251101");
	if (OutputPath.IsEmpty()) OutputPath = TEXT("/Game/PCGExBridge/Generated");
}

void FPCGExBridgeSettings::Save() const
{
	GConfig->SetString(Section, KeyApiKey,     *ApiKey,      GEditorPerProjectIni);
	GConfig->SetString(Section, KeyBaseURL,    *BaseURL,     GEditorPerProjectIni);
	GConfig->SetString(Section, KeyModel,      *Model,       GEditorPerProjectIni);
	GConfig->SetString(Section, KeyOutputPath, *OutputPath,  GEditorPerProjectIni);
	GConfig->Flush(false, GEditorPerProjectIni);
}
