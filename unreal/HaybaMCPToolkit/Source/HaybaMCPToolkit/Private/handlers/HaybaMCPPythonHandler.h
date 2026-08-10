#pragma once
#include "IHaybaMCPHandler.h"

enum class EPythonTier : uint8 { ReadOnly = 1, Mutation = 2, Unsafe = 3 };

class FHaybaMCPPythonHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("python"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

#if WITH_DEV_AUTOMATION_TESTS
    /** Exact fatal table exported only to prove every native deny rule through
     *  Handle(), including with allow_unsafe=true. */
    static TArray<TPair<FString, FString>> FatalPolicyCasesForTests();
    static bool MatchFatalPolicyForTests(const FString& Script, FString& OutPolicyCode);
    static bool IsTier3PolicyBlockedForTests(
        const FString& Script,
        bool bSettingAllows,
        bool bAllowUnsafeOverride);
#endif

private:
    FHaybaHandlerResult Run(const TSharedPtr<FJsonObject>& P);
    static EPythonTier ClassifyScript(const FString& Code);
};
