#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPUIHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("ui"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult HandleCreateWidget(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleAddElement(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleSetProperties(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleQuery(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleMutateTree(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleCompile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleSave(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult HandleListTypes(const TSharedPtr<FJsonObject>& P);
};
