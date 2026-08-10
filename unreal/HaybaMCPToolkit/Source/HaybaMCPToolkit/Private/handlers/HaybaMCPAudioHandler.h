#pragma once
#include "IHaybaMCPHandler.h"

class UAudioComponent;

class FHaybaMCPAudioHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("audio"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    TMap<FString, TWeakObjectPtr<UAudioComponent>> ManagedComponents;
    TSet<FString> ActiveAnalyzers;
    TSet<FString> ActiveRecordings;
};
