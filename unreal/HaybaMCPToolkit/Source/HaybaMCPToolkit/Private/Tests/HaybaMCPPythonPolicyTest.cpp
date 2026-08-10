#if WITH_DEV_AUTOMATION_TESTS

#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPPythonHandler.h"
#include "Dom/JsonObject.h"

namespace
{
    FHaybaHandlerResult RunPolicyProbe(
        FHaybaMCPPythonHandler& Handler,
        const FString& Script,
        const bool bAllowUnsafe = true)
    {
        TSharedPtr<FJsonObject> Params = MakeShared<FJsonObject>();
        Params->SetStringField(TEXT("script"), Script);
        Params->SetBoolField(TEXT("allow_unsafe"), bAllowUnsafe);
        return Handler.Handle(TEXT("python_run"), Params);
    }

    void ExpectPolicyRejection(
        FAutomationTestBase& Test,
        FHaybaMCPPythonHandler& Handler,
        const FString& Script,
        const FString& ExpectedCode)
    {
        const FHaybaHandlerResult Result = RunPolicyProbe(Handler, Script, true);
        const FString Label = FString::Printf(TEXT("native policy rejects %s"), *Script);
        Test.TestFalse(*Label, Result.bOk);
        Test.TestTrue(*(Label + TEXT(" with stable code")), Result.ErrorMessage.Contains(ExpectedCode));
        Test.TestTrue(*(Label + TEXT(" with recovery")), Result.ErrorMessage.Contains(TEXT("Safe alternative:")));
        Test.TestTrue(
            *(Label + TEXT(" as non-retryable")),
            Result.ErrorMessage.Contains(TEXT("Retry unchanged: forbidden")));
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPythonFatalPolicyTest,
    "Hayba.MCP.Python.FatalPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPythonFatalPolicyTest::RunTest(const FString& Parameters)
{
    FHaybaMCPPythonHandler Handler;

    // This list is generated from the production table, so a newly added rule
    // automatically acquires a direct Handle() probe. allow_unsafe=true proves
    // the crash policy sits below the optional Tier-3 sandbox.
    for (const TPair<FString, FString>& Case : Handler.FatalPolicyCasesForTests())
    {
        ExpectPolicyRejection(*this, Handler, Case.Key, Case.Value);
    }

    // Human-readable probes prove normalization/alias handling rather than
    // merely feeding the raw table fragments back to the matcher.
    const TArray<TPair<FString, FString>> AliasCases = {
        { TEXT("unreal.EditorLoadingAndSavingUtils . LOAD_MAP ('/Game/X')"), TEXT("HCR-WORLD-001") },
        { TEXT("list_view.set_list_items(items + items)"), TEXT("HCR-UI-001") },
        { TEXT("list_view.set_editor_property('list_items', items)"), TEXT("HCR-UI-001") },
        { TEXT("from THREADING import Thread as Worker\nWorker(target=cb).start()"), TEXT("HCR-LIFE-001") },
        { TEXT("from TIME import SLEEP as pause\npause(5)"), TEXT("HCR-BLOCK-001") },
        { TEXT("import os as process\nprocess._exit(1)"), TEXT("HCR-EXIT-001") },
        { TEXT("import signal as sig\nsig.raise_signal(6)"), TEXT("HCR-EXIT-001") },
        { TEXT("SYS . SETTRACE ( None )"), TEXT("HCR-TIME-001") },
        { TEXT("client.connect(('::1', 52350))"), TEXT("HCR-BLOCK-001") },
    };
    for (const TPair<FString, FString>& Case : AliasCases)
    {
        ExpectPolicyRejection(*this, Handler, Case.Key, Case.Value);
    }

    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPythonPolicyBoundaryTest,
    "Hayba.MCP.Python.PolicyBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPythonPolicyBoundaryTest::RunTest(const FString& Parameters)
{
    FHaybaMCPPythonHandler Handler;

    // Token boundaries keep strict matching from breaking similarly named UE
    // APIs. This calls the pure matcher and never invokes PythonScriptPlugin.
    const TArray<FString> SafeScripts = {
        TEXT("node.set_input('Gain', 1.0)"),
        TEXT("blueprint.recompile()"),
        TEXT("import timer"),
    };
    for (const FString& SafeScript : SafeScripts)
    {
        FString PolicyCode;
        TestFalse(
            *FString::Printf(TEXT("callable token boundaries accept %s"), *SafeScript),
            Handler.MatchFatalPolicyForTests(SafeScript, PolicyCode));
    }

    const FHaybaHandlerResult Oversized = RunPolicyProbe(
        Handler,
        FString::ChrN((256 * 1024) + 1, TEXT('x')),
        true);
    TestFalse(TEXT("oversized script is rejected before Python"), Oversized.bOk);
    TestTrue(TEXT("oversized refusal has stable code"), Oversized.ErrorMessage.Contains(TEXT("HCR-SIZE-001")));

    // Exercise the same production predicate without depending on a user's
    // project setting or actually opening a subprocess from an automation test.
    const FString Tier3Script = TEXT("SuBpRoCeSs . Popen(['tool'])");
    TestTrue(
        TEXT("Tier-3 blocks with neither grant"),
        Handler.IsTier3PolicyBlockedForTests(Tier3Script, false, false));
    TestFalse(
        TEXT("per-call allow_unsafe grants only Tier-3"),
        Handler.IsTier3PolicyBlockedForTests(Tier3Script, false, true));
    TestFalse(
        TEXT("plugin setting grants Tier-3"),
        Handler.IsTier3PolicyBlockedForTests(Tier3Script, true, false));

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
