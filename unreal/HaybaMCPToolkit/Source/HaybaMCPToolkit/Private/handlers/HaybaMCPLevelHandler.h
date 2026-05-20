#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPLevelHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("level"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult LevelList(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelLoad(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelSave(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelCreate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelGetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelGetSpatialIndex(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelSetBookmark(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult LevelGotoBookmark(const TSharedPtr<FJsonObject>& P);
};
