#include "HaybaGaeaSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"

FHaybaGaeaSettings& FHaybaGaeaSettings::Get()
{
	static FHaybaGaeaSettings Instance;
	return Instance;
}

FString FHaybaGaeaSettings::GetSharedApiKey()
{
	FString Key;
	GConfig->GetString(TEXT("HaybaShared"), TEXT("ApiKey"), Key, GEditorPerProjectIni);
	return Key;
}

void FHaybaGaeaSettings::SetSharedApiKey(const FString& Key)
{
	GConfig->SetString(TEXT("HaybaShared"), TEXT("ApiKey"), *Key, GEditorPerProjectIni);
	GConfig->Flush(false, GEditorPerProjectIni);
}

void FHaybaGaeaSettings::Load()
{
	GConfig->GetString(Section, TEXT("ServerHost"), ServerHost, GEditorPerProjectIni);
	GConfig->GetInt(Section, TEXT("ServerPort"), ServerPort, GEditorPerProjectIni);
	GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);
	GConfig->GetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);

	FString ModeStr;
	GConfig->GetString(Section, TEXT("OperationMode"), ModeStr, GEditorPerProjectIni);
	OperationMode = (ModeStr == TEXT("ApiKey")) ? EHaybaOperationMode::ApiKey : EHaybaOperationMode::Integrated;

	if (ServerHost.IsEmpty()) ServerHost = TEXT("127.0.0.1");
	if (ServerPort <= 0) ServerPort = 55558;
	if (HeightmapOutputFolder.IsEmpty())
		HeightmapOutputFolder = FPaths::ProjectSavedDir() / TEXT("HaybaGaea");
}

void FHaybaGaeaSettings::Save() const
{
	GConfig->SetString(Section, TEXT("ServerHost"), *ServerHost, GEditorPerProjectIni);
	GConfig->SetInt(Section, TEXT("ServerPort"), ServerPort, GEditorPerProjectIni);
	GConfig->SetString(Section, TEXT("HeightmapOutputFolder"), *HeightmapOutputFolder, GEditorPerProjectIni);
	GConfig->SetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
	GConfig->SetString(Section, TEXT("OperationMode"),
		OperationMode == EHaybaOperationMode::ApiKey ? TEXT("ApiKey") : TEXT("Integrated"),
		GEditorPerProjectIni);
	GConfig->Flush(false, GEditorPerProjectIni);
}
