#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPDataAssetHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("data"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
