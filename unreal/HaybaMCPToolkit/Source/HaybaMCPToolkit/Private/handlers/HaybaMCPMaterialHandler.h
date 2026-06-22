#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPMaterialHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("material"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult MatCreate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatFunctionCreate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatAddNode(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatSetNode(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatDeleteNode(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatAddComment(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatAddRerouteDeclaration(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatAddRerouteUsage(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatConnectNodes(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatCreateInstance(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatSetParam(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatApply(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatList(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MatGetInfo(const TSharedPtr<FJsonObject>& P);
};
