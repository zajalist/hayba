#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPDocsHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("docs"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult Search(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LookupClass(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LookupApi(const TSharedPtr<FJsonObject>& P);
};
