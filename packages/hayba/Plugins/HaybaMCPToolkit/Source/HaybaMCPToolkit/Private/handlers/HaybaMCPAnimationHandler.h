#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPAnimationHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("anim"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;
};
