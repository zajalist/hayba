#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPNiagaraHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("niagara"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult NiagaraList(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult NiagaraSpawn(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult NiagaraSetParam(const TSharedPtr<FJsonObject>& P);
};
