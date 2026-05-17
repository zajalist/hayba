#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPISMHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("ism"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult IsmCreateActor(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult IsmAddInstance(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult IsmAddInstances(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult IsmClearInstances(const TSharedPtr<FJsonObject>& P);
};
