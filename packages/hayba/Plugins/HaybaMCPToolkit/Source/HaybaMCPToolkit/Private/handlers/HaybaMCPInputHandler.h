#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPInputHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("input"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
