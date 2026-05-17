#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPPerfHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("perf"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult GetPerfStats(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult TextureAudit(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult MeshAudit(const TSharedPtr<FJsonObject>& P);
};
