#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPPhysicsHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("physics"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
private:
    FHaybaHandlerResult PhysicsSetSimulate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PhysicsSetCollisionProfile(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult PhysicsAddImpulse(const TSharedPtr<FJsonObject>& P);
};
