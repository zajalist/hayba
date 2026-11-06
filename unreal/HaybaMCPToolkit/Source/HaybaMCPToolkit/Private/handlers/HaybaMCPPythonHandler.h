#pragma once
#include "IHaybaMCPHandler.h"

enum class EPythonTier : uint8 { ReadOnly = 1, Mutation = 2, Unsafe = 3 };

class FHaybaMCPPythonHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("python"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

    /** True when the lexical tier classifier finds no mutation or unsafe
     *  keyword. Weak evidence (see HaybaMCPAccess::ClassifyPythonRun); used
     *  only to pick the script's lease access class. */
    static bool IsReadOnlyScriptForAccess(const FString& Code) { return ClassifyScript(Code) == EPythonTier::ReadOnly; }

    /** Apply Resources/Python/hayba_psp_hotfix.py once per editor session (PythonScriptPlugin's
     *  closure type crashes CPython's GC). False only while Python is not initialized yet. */
    static bool EnsurePspHotfix();

#if WITH_DEV_AUTOMATION_TESTS
    /** Exact fatal table exported only to prove every native deny rule through
     *  the pure source-policy matcher. Destructive examples must never reach
     *  Handle(): a matcher regression should fail a test, not execute them. */
    static TArray<TPair<FString, FString>> FatalPolicyCasesForTests();
    static bool MatchFatalPolicyForTests(const FString& Script, FString& OutPolicyCode);
    static bool IsTier3PolicyBlockedForTests(
        const FString& Script,
        bool bSettingAllows,
        bool bAllowUnsafeOverride);
#endif

private:
    FHaybaHandlerResult Run(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ExecFile(const TSharedPtr<FJsonObject>& P);
    static EPythonTier ClassifyScript(const FString& Code);
};
