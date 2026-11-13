#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPFabHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("fab"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params) override;
};
