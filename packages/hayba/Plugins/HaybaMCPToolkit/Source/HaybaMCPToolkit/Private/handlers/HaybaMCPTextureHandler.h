#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPTextureHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("texture"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
