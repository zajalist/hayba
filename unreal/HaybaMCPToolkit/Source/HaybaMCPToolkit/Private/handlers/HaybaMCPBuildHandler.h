#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPBuildHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("build"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
