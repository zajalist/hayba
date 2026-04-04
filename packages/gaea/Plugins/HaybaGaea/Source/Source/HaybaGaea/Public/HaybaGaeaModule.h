#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class FHaybaGaeaModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

	void SendGenerateRequest(const FString& Prompt, const FString& OutputFolder,
		TFunction<void(bool, const FString&)> Callback);

private:
	TSharedRef<SDockTab> OnSpawnTab(const FSpawnTabArgs& Args);

	IConsoleCommand* OpenCommand = nullptr;
};
