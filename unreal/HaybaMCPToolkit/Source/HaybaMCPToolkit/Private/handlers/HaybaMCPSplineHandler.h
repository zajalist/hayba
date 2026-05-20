#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPSplineHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("spline"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult SplineCreate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SplineAddPoint(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SplineSetPoint(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SplineRemovePoint(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SplineGetInfo(const TSharedPtr<FJsonObject>& P);
};
