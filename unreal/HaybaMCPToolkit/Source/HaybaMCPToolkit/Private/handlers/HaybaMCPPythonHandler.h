#pragma once
#include "IHaybaMCPHandler.h"

enum class EPythonTier : uint8 { ReadOnly = 1, Mutation = 2, Unsafe = 3 };

class FHaybaMCPPythonHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("python"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult Run(const TSharedPtr<FJsonObject>& P);
    static EPythonTier ClassifyScript(const FString& Code);
};
