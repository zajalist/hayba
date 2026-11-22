#pragma once
#include "IHaybaMCPHandler.h"

/** Executes only the bundled read-only inspector, never a caller-supplied script. */
class FHaybaMCPChooserHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("chooser"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params) override;
    static bool BuildRequest(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutPython, FString& OutError);
};
