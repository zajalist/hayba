#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPUIHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("ui"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
