#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPBlueprintHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("blueprint"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult Create(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddComponent(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddVariable(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddFunction(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddNode(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ConnectNodes(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Compile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Document(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddEvent(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetDefaults(const TSharedPtr<FJsonObject>& P);
};
