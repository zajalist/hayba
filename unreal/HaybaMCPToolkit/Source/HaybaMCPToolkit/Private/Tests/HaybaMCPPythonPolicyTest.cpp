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
        { TEXT("import os as process\nprocess.abort()"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as process\nprocess.kill(process.getpid(), 9)"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as process\nstop_now = process.abort\nstop_now()"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as process\nprocess.kill.__call__(process.getpid(), 9)"), TEXT("HCR-EXIT-001") },
        { TEXT("import os\nos.__getattribute__('abort')()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import operator, os\noperator.attrgetter('abort')(os)()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from operator import attrgetter as pick\nimport os\npick('abort')(os)()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import operator, os\noperator.methodcaller('kill', 123, 9)(os)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("f'{os.abort()}'"), TEXT("HCR-EXIT-001") },
        { TEXT("F\"{os.abort()}\""), TEXT("HCR-EXIT-001") },
        { TEXT("rf'{os.abort()}'"), TEXT("HCR-EXIT-001") },
        { TEXT("Fr\"{('literal', os.abort())[1]}\""), TEXT("HCR-EXIT-001") },
        { TEXT("f\"prefix {os.kill(123, 9)} suffix\""), TEXT("HCR-EXIT-001") },
        { TEXT("import os as module_alias\nfirst_hop = module_alias\nfirst_hop.abort()"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as module_alias\nfirst_hop = module_alias\nsecond_hop = first_hop\nsecond_hop.kill(123, 9)"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as module_alias\nwrapped_hop = ((module_alias))\nwrapped_hop.abort()"), TEXT("HCR-EXIT-001") },
        { TEXT("import sys as module_alias\nfirst_hop = module_alias\nfirst_hop.settrace(None)"), TEXT("HCR-TIME-001") },
        { TEXT("from os import abort as stop_now\nstop_now()"), TEXT("HCR-EXIT-001") },
        { TEXT("from os import kill as signal_process\nsignal_process(123, 9)"), TEXT("HCR-EXIT-001") },
        { TEXT("import signal as sig\nsig.raise_signal(6)"), TEXT("HCR-EXIT-001") },
        { TEXT("import sys as runtime\nruntime.settrace(None)"), TEXT("HCR-TIME-001") },
        { TEXT("from sys import settrace as disable_deadline\ndisable_deadline(None)"), TEXT("HCR-TIME-001") },
        { TEXT("import time as clock\nclock.sleep(5)"), TEXT("HCR-BLOCK-001") },
        { TEXT("import threading as workers\nworkers.Thread(target=cb).start()"), TEXT("HCR-LIFE-001") },
        { TEXT("from unreal import EditorLoadingAndSavingUtils as Loader\nLoader.load_map('/Game/X')"), TEXT("HCR-WORLD-001") },
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
        TEXT("print('os.abort() is forbidden')"),
        TEXT("# import os as process; process.abort()\nvalue = 1"),
        TEXT("f'os.abort() is literal text'"),
        TEXT("f'{{os.abort() is escaped literal text}}'"),
        TEXT("RF'{{os.abort() is escaped literal text}}'"),
        TEXT("f\"{'os.abort() is a nested quoted literal'}\""),
        TEXT("import os as module_alias\nfirst_hop = module_alias\nfirst_hop = harmless\nfirst_hop.abort()"),
        TEXT("import os as module_alias\nfirst_hop = module_alias\nfirst_hop = harmless()\nfirst_hop.abort()"),
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

    FString DeepFString = TEXT("os.abort()");
    for (int32 Depth = 0; Depth < 32; ++Depth)
    {
        DeepFString = FString::Printf(TEXT("f'{%s}'"), *DeepFString);
    }
    FString DeepPolicyCode;
    TestTrue(TEXT("hostile f-string nesting fails closed without unbounded recursion"),
        Handler.MatchFatalPolicyForTests(DeepFString, DeepPolicyCode));
    TestEqual(TEXT("deep f-string refusal uses stable dynamic-policy code"),
        DeepPolicyCode, FString(TEXT("HCR-DYNAMIC-001")));

    FString LargeNestedFString = FString::ChrN(240 * 1024, TEXT('a'));
    for (int32 Depth = 0; Depth < 8; ++Depth)
    {
        LargeNestedFString = FString::Printf(TEXT("f'{%s}'"), *LargeNestedFString);
    }
    FString LargeNestedPolicyCode;
    TestTrue(TEXT("large nested f-string exhausts the global lex-work budget fail closed"),
        Handler.MatchFatalPolicyForTests(LargeNestedFString, LargeNestedPolicyCode));
    TestEqual(TEXT("lex-work budget refusal uses stable dynamic-policy code"),
        LargeNestedPolicyCode, FString(TEXT("HCR-DYNAMIC-001")));

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPythonOutputBoundaryTest,
    "Hayba.MCP.Python.OutputBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPythonOutputBoundaryTest::RunTest(const FString& Parameters)
{
    FHaybaMCPPythonHandler Handler;

    // This is an execution regression, not a pure source-policy assertion. It
    // proves stdout and stderr are each bounded before they cross back to C++.
    const FHaybaHandlerResult LargeOutput = RunPolicyProbe(
        Handler,
        TEXT("import sys\nprint('o' * 131072)\nprint('e' * 131072, file=sys.stderr)"),
        true);
    if (TestTrue(TEXT("bounded-output script executes"), LargeOutput.bOk)
        && TestTrue(TEXT("bounded-output response has data"), LargeOutput.Data.IsValid()))
    {
        bool bStdOutTruncated = false;
        bool bStdErrTruncated = false;
        double StdOutDropped = 0;
        double StdErrDropped = 0;
        double CaptureLimit = 0;
        const FString StdOut = LargeOutput.Data->GetStringField(TEXT("stdout"));
        const FString StdErr = LargeOutput.Data->GetStringField(TEXT("stderr"));
        TestTrue(TEXT("stdout truncation fact is stable"),
            LargeOutput.Data->TryGetBoolField(TEXT("stdout_truncated"), bStdOutTruncated) && bStdOutTruncated);
        TestTrue(TEXT("stderr truncation fact is stable"),
            LargeOutput.Data->TryGetBoolField(TEXT("stderr_truncated"), bStdErrTruncated) && bStdErrTruncated);
        TestTrue(TEXT("stdout dropped count is reported"),
            LargeOutput.Data->TryGetNumberField(TEXT("stdout_chars_dropped"), StdOutDropped) && StdOutDropped > 0);
        TestTrue(TEXT("stderr dropped count is reported"),
            LargeOutput.Data->TryGetNumberField(TEXT("stderr_chars_dropped"), StdErrDropped) && StdErrDropped > 0);
        TestTrue(TEXT("capture limit is reported"),
            LargeOutput.Data->TryGetNumberField(TEXT("capture_limit_chars_per_stream"), CaptureLimit)
            && CaptureLimit == 64 * 1024);
        TestTrue(TEXT("stdout never exceeds its advertised cap"),
            StdOut.Len() <= static_cast<int32>(CaptureLimit));
        TestTrue(TEXT("stderr never exceeds its advertised cap"),
            StdErr.Len() <= static_cast<int32>(CaptureLimit));
    }

    // Capture must not invoke an arbitrary object's __str__: besides creating
    // an enormous temporary, an Unreal wrapper can enter unsafe native code.
    const FHaybaHandlerResult HostileConversion = RunPolicyProbe(
        Handler,
        TEXT("class Hostile:\n"
             "    def __str__(self):\n"
             "        raise RuntimeError('capture invoked arbitrary __str__')\n"
             "print(Hostile())"),
        true);
    if (TestTrue(TEXT("hostile conversion is contained"), HostileConversion.bOk)
        && TestTrue(TEXT("hostile conversion has data"), HostileConversion.Data.IsValid()))
    {
        TestTrue(TEXT("user script completed without invoking __str__"),
            HostileConversion.Data->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("non-primitive omission is explicit"),
            HostileConversion.Data->GetStringField(TEXT("stdout"))
                .Contains(TEXT("non-primitive value omitted by bounded capture")));
        TestEqual(TEXT("capture value policy tells callers to serialize deliberately"),
            HostileConversion.Data->GetStringField(TEXT("capture_value_policy")),
            FString(TEXT("bounded_primitive_only")));
    }

    // Exception reporting is also streamed through the bounded sink; it never
    // materializes traceback.format_exc() or an unbounded exception string.
    const FHaybaHandlerResult LargeException = RunPolicyProbe(
        Handler,
        TEXT("raise RuntimeError('z' * 131072)"),
        true);
    if (TestTrue(TEXT("large exception is contained by handler"), LargeException.bOk)
        && TestTrue(TEXT("large exception has data"), LargeException.Data.IsValid()))
    {
        TestFalse(TEXT("user exception is reported as failed"),
            LargeException.Data->GetBoolField(TEXT("ok")));
        TestFalse(TEXT("exception arguments are omitted before they can amplify stderr"),
            LargeException.Data->GetBoolField(TEXT("stderr_truncated")));
        TestTrue(TEXT("exception omission is explicit"),
            LargeException.Data->GetStringField(TEXT("stderr"))
                .Contains(TEXT("exception arguments omitted by bounded capture")));
        TestTrue(TEXT("large exception stderr stays bounded"),
            LargeException.Data->GetStringField(TEXT("stderr")).Len() <= 64 * 1024);
    }

    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
