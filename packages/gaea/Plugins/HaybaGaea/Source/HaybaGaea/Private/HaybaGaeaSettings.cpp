#include "HaybaGaeaSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"

FHaybaGaeaSettings& FHaybaGaeaSettings::Get()
{
	static FHaybaGaeaSettings Instance;
	return Instance;
}

void FHaybaGaeaSettings::Load()
{
	GConfig->GetString(Section, TEXT("ServerHost"), ServerHost, GEditorPerProjectIni);
	GConfig->GetInt(Section, TEXT("ServerPort"), ServerPort, GEditorPerProjectIni);
	GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);

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
	GConfig->Flush(false, GEditorPerProjectIni);
}
