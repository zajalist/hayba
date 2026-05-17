#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPFoliageHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("foliage"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult FoliageAddInstance(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult FoliageRemoveInstances(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult FoliageListTypes(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult FoliagePaintAt(const TSharedPtr<FJsonObject>& P);
};
