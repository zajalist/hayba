#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPAssetHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("asset"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult AssetSearch(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetImport(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetDuplicate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetDelete(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetGetReferences(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetValidate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AssetRename(const TSharedPtr<FJsonObject>& P);
};
