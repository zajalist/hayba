#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPWorldPartitionHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("wp"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult WpGetCells(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult WpLoadCell(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult WpGetStreamingState(const TSharedPtr<FJsonObject>& P);
};
