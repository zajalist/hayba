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

    void ExpectPurePolicyRejection(
        FAutomationTestBase& Test,
        FHaybaMCPPythonHandler& Handler,
        const FString& Script,
        const FString& ExpectedCode)
    {
        FString PolicyCode;
        const FString Label = FString::Printf(TEXT("pure native policy rejects %s"), *Script);
        Test.TestTrue(*Label, Handler.MatchFatalPolicyForTests(Script, PolicyCode));
        Test.TestEqual(*(Label + TEXT(" with stable code")), PolicyCode, ExpectedCode);
    }
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPPythonFatalPolicyTest,
    "Hayba.MCP.Python.FatalPolicy",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPPythonFatalPolicyTest::RunTest(const FString& Parameters)
{
    FHaybaMCPPythonHandler Handler;

    // Never route a fatal example through Handle(): a matcher regression must
    // fail this test, not execute the payload in the serving editor. This list
    // is generated from the production table and exercises only the pure
    // source-policy matcher.
    for (const TPair<FString, FString>& Case : Handler.FatalPolicyCasesForTests())
    {
        ExpectPurePolicyRejection(*this, Handler, Case.Key, Case.Value);
    }

    // Human-readable probes prove normalization/alias handling rather than
    // merely feeding the raw table fragments back to the matcher.
    const TArray<TPair<FString, FString>> AliasCases = {
        { TEXT("unreal.EditorLoadingAndSavingUtils . LOAD_MAP ('/Game/X')"), TEXT("HCR-WORLD-001") },
        { TEXT("list_view.set_list_items(items + items)"), TEXT("HCR-UI-001") },
        { TEXT("list_view.set_editor_property('list_items', items)"), TEXT("HCR-UI-001") },
        { TEXT("from THREADING import Thread as Worker\nWorker(target=cb).start()"), TEXT("HCR-LIFE-001") },
        { TEXT("from TIME import SLEEP as pause\npause(5)"), TEXT("HCR-TIME-001") },
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
        { TEXT("import sys as runtime\nruntime.settrace = lambda fn: None"), TEXT("HCR-TIME-001") },
        { TEXT("import sys as module_alias\nfirst_hop = module_alias\nfirst_hop.settrace = lambda fn: None"), TEXT("HCR-TIME-001") },
        { TEXT("import os\nos.sys.settrace = lambda fn: None"), TEXT("HCR-TIME-001") },
        { TEXT("_hb_trace_events = 0"), TEXT("HCR-TIME-001") },
        { TEXT("import __main__ as host\nhost._hb_deadline = 999999999"), TEXT("HCR-TIME-001") },
        { TEXT("import sys\nsys.modules['__main__']._hb_deadline = 999999999"), TEXT("HCR-TIME-001") },
        { TEXT("import inspect\ninspect.currentframe().f_back.f_locals['_hb_deadline'] = 999999999"), TEXT("HCR-TIME-001") },
        { TEXT("import builtins\nbuiltins.print = print"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import time as clock\nclock.sleep(5)"), TEXT("HCR-TIME-001") },
        { TEXT("import threading as workers\nworkers.Thread(target=cb).start()"), TEXT("HCR-LIFE-001") },
        { TEXT("from unreal import EditorLoadingAndSavingUtils as Loader\nLoader.load_map('/Game/X')"), TEXT("HCR-WORLD-001") },
        { TEXT("client.connect(('::1', 52350))"), TEXT("HCR-BLOCK-001") },
        { TEXT("try:\n    value = 1\nfinally:\n    value = 2"), TEXT("HCR-TIME-001") },
        { TEXT("from contextlib import nullcontext\nwith nullcontext():\n    pass"), TEXT("HCR-TIME-001") },
    };
    for (const TPair<FString, FString>& Case : AliasCases)
    {
        ExpectPurePolicyRejection(*this, Handler, Case.Key, Case.Value);
    }

    // Pure matcher probes: if one of these regresses, never execute the script
    // merely to prove it, because the os.abort case terminates the host.
    const TArray<TPair<FString, FString>> PolicyOnlyCases = {
        { TEXT("__builtins__['__import__']('sys').settrace(None)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("__builtins__['__import__']('os').abort()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("try:\n    work()\nexcept:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("try:\n    work()\nexcept BaseException:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("CatchAll = BaseException\ntry:\n    work()\nexcept CatchAll:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("FirstCatch = BaseException\nSecondCatch = FirstCatch\ntry:\n    work()\nexcept SecondCatch:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("try:\n    work()\nexcept Exception.__base__:\n    pass"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("CatchAll = Exception.__base__\ntry:\n    work()\nexcept CatchAll:\n    pass"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("try:\n    work()\nexcept imported.Errors[0]:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("try:\n    work()\nexcept make_exception_type():\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("try:\n    work()\nexcept external.CustomError:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("def run(Exception):\n    try:\n        work()\n    except Exception:\n        pass\nrun(BaseException)"), TEXT("HCR-TIME-001") },
        { TEXT("Recoverable = Exception\ndef run():\n    try:\n        work()\n    except Recoverable:\n        pass\nRecoverable = BaseException\nrun()"), TEXT("HCR-TIME-001") },
        { TEXT("from external import Fatal as Exception\ntry:\n    work()\nexcept Exception:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("imp = __import__\nosmod = imp('os')\nstop = osmod.abort\nstop()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("run_hidden = exec\nrun_hidden(\"import os; os.abort()\")"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("pick = getattr\nstop = pick(os, 'abort')\nstop()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("mutate = setattr\nmutate(sys, 'settrace', lambda value: None)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from sys import settrace\ndisable = settrace\ndisable(None)"), TEXT("HCR-TIME-001") },
        { TEXT("import os\npick = object.__getattribute__\nstop = pick(os, 'abort')\nstop()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import os\npick = type.__getattribute__\nstop = pick(type(os), '__call__')"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("(Exception := BaseException)\ntry:\n    work()\nexcept Exception:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("(Exception,) = (BaseException,)\ntry:\n    work()\nexcept Exception:\n    pass"), TEXT("HCR-TIME-001") },
        { TEXT("with resource():\n    work()"), TEXT("HCR-TIME-001") },
        { TEXT("async with resource():\n    await work()"), TEXT("HCR-TIME-001") },
        { TEXT("import inspect as probe\nstop = probe.getattr_static(os, 'abort')\nstop()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from inspect import getmembers as members\nitems = members(os)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import pydoc as docs\nstop = docs.locate('os.abort')\nstop()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import pickle as codec\nvalue = codec.loads(payload)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from marshal import loads as decode\nvalue = decode(payload)"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import types as runtime_types"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import pkgutil as packages"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import runpy as runner"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import importlib.util as loader"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import time"), TEXT("HCR-TIME-001") },
        { TEXT("from base64 import b64decode as decode"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import gc as collector"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import sys as runtime"), TEXT("HCR-TIME-001") },
        { TEXT("import traceback"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from math import *"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("from time import *"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("().__class__.__base__.__subclasses__()"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("object.__subclasses__()[0].load_module('os')"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("BuiltinImporter.load_module('os')"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("loader.find_spec('os')"), TEXT("HCR-DYNAMIC-001") },
        { TEXT("import os as process\n(stop_now := process.abort)()"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as process\ndef stop(fn=process.kill):\n    fn(123, 9)\nstop()"), TEXT("HCR-EXIT-001") },
        { TEXT("import os as process\n(stop_now,) = (process._exit,)\nstop_now(1)"), TEXT("HCR-EXIT-001") },
        { TEXT("import sys as runtime\n(disable := runtime.settrace)(None)"), TEXT("HCR-TIME-001") },
        { TEXT("service.abort()"), TEXT("HCR-EXIT-001") },
        { TEXT("controller.kill(123, 9)"), TEXT("HCR-EXIT-001") },
        { TEXT("runtime._exit(1)"), TEXT("HCR-EXIT-001") },
        { TEXT("runtime.settrace(None)"), TEXT("HCR-TIME-001") },
        { TEXT("import threading\ngate = threading.Lock()\ngate.acquire()\ngate.acquire()"), TEXT("HCR-BLOCK-001") },
        { TEXT("from threading import RLock as Gate\ngate = Gate()\ngate.acquire()"), TEXT("HCR-BLOCK-001") },
        { TEXT("import threading\nthreading.Event().wait()"), TEXT("HCR-BLOCK-001") },
        { TEXT("import threading\nthreading.Condition().wait()"), TEXT("HCR-BLOCK-001") },
        { TEXT("import threading\nthreading.Semaphore(0).acquire()"), TEXT("HCR-BLOCK-001") },
        { TEXT("import queue as queues\nitems = queues.Queue()\nitems.get()"), TEXT("HCR-BLOCK-001") },
        { TEXT("from queue import Queue\nitems = Queue()\nitems.join()"), TEXT("HCR-BLOCK-001") },
        { TEXT("from concurrent.futures import Future\nFuture.result(pending)"), TEXT("HCR-BLOCK-001") },
        { TEXT("import concurrent.futures as futures\nfutures.wait(pending)"), TEXT("HCR-BLOCK-001") },
    };
    for (const TPair<FString, FString>& Case : PolicyOnlyCases)
    {
        ExpectPurePolicyRejection(*this, Handler, Case.Key, Case.Value);
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
        TEXT("print('_hb_deadline and __main__ are wrapper internals')"),
        TEXT("# __main__._hb_deadline = 0\nvalue = 'sys.settrace = harmless text'"),
        TEXT("print('sys.settrace(None) is rejected when executable')"),
        TEXT("# sys.settrace(None) is disabled here\nvalue = 1"),
        TEXT("module.settrace_policy('keep')"),
        TEXT("status = {'modules': 1, 'f_back': 0}"),
        TEXT("print('__builtins__ is reserved only when executable')"),
        TEXT("# __builtins__['__import__']('sys').settrace(None)\nvalue = 1"),
        TEXT("print('except BaseException: is rejected only as executable syntax')"),
        TEXT("# except:\n#     swallow_deadline()\nvalue = 1"),
        TEXT("print('try: and with resource(): are policy examples, not syntax')"),
        TEXT("# try:\n#     work()\n# finally:\n#     cleanup()\nvalue = 1"),
        TEXT("# with resource():\n#     work()\nvalue = 1"),
        TEXT("print('inspect.getattr_static, pydoc.locate, and pickle.loads are blocked imports')"),
        TEXT("# import inspect as probe\n# probe.getmembers(os)\nvalue = 1"),
        TEXT("module_name = 'importlib.util'; similarly_named_inspector = 1"),
        TEXT("worker.kill_switch()"),
        TEXT("module.settrace_policy('keep')"),
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

    // A short RHS can still grow an alias path on every statement. Keep this
    // below the source/token ceilings and prove the shared alias copy-work cap
    // fails closed instead of doing quadratic FString copying.
    FString AliasGrowth;
    AliasGrowth.Reserve(180 * 1024);
    AliasGrowth = TEXT("import os as x\n");
    for (int32 Line = 0; Line < 30000; ++Line)
    {
        AliasGrowth += TEXT("x=x.x\n");
    }
    FString AliasBudgetPolicyCode;
    TestTrue(TEXT("growing alias paths exhaust bounded copy work fail closed"),
        Handler.MatchFatalPolicyForTests(AliasGrowth, AliasBudgetPolicyCode));
    TestEqual(TEXT("alias copy-work refusal uses stable dynamic-policy code"),
        AliasBudgetPolicyCode, FString(TEXT("HCR-DYNAMIC-001")));

    FString DottedImport = TEXT("import a");
    DottedImport.Reserve(128 * 1024);
    for (int32 Component = 1; Component < 64; ++Component)
    {
        DottedImport += TEXT(".a");
    }
    FString DottedImportPolicyCode;
    TestFalse(TEXT("dotted import at component bound remains inspectable"),
        Handler.MatchFatalPolicyForTests(DottedImport, DottedImportPolicyCode));
    for (int32 Component = 64; Component < 30000; ++Component)
    {
        DottedImport += TEXT(".a");
    }
    TestTrue(TEXT("componentized dotted name fails before quadratic FString construction"),
        Handler.MatchFatalPolicyForTests(DottedImport, DottedImportPolicyCode));
    TestEqual(TEXT("dotted-name bound uses stable dynamic-policy code"),
        DottedImportPolicyCode, FString(TEXT("HCR-DYNAMIC-001")));

    FString MalformedImports;
    MalformedImports.Reserve(192 * 1024);
    for (int32 Repeat = 0; Repeat < 12000; ++Repeat)
    {
        MalformedImports += TEXT("from pkg import ");
    }
    FString MalformedImportPolicyCode;
    TestTrue(TEXT("malformed from-import continuation fails closed without overlapping rescans"),
        Handler.MatchFatalPolicyForTests(MalformedImports, MalformedImportPolicyCode));
    TestEqual(TEXT("malformed import refusal uses stable dynamic-policy code"),
        MalformedImportPolicyCode, FString(TEXT("HCR-DYNAMIC-001")));

    // Exercise the same production predicate without depending on a user's
    // project setting or performing any filesystem/process mutation.
    const TArray<FString> Tier3Scripts = {
        TEXT("SuBpRoCeSs . Popen(['tool'])"),
        TEXT("import os as files\nfiles.remove(target)"),
        TEXT("import os as files\nfiles.unlink(target)"),
        TEXT("import os as files\nfiles.rename(source, target)"),
        TEXT("import os as files\nfiles.replace(source, target)"),
        TEXT("import os as files\nfiles.mkdir(target)"),
        TEXT("import os as files\nfiles.rmdir(target)"),
        TEXT("from pathlib import Path\nPath(target).write_text(data)"),
        TEXT("from pathlib import Path\nPath(target).write_bytes(data)"),
        TEXT("from pathlib import Path\nPath(target).unlink()"),
        TEXT("from pathlib import Path\nPath(source).rename(target)"),
        TEXT("from pathlib import Path\nPath(source).replace(target)"),
        TEXT("from pathlib import Path\nPath(target).mkdir()"),
        TEXT("from pathlib import Path\nPath(target).rmdir()"),
        TEXT("from pathlib import Path\nPath(target).touch()"),
    };
    for (const FString& Tier3Script : Tier3Scripts)
    {
        TestTrue(
            *FString::Printf(TEXT("Tier-3 blocks detected primitive with neither grant: %s"), *Tier3Script),
            Handler.IsTier3PolicyBlockedForTests(Tier3Script, false, false));
    }
    const FString Tier3Script = Tier3Scripts[0];
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
        TEXT("print('o' * 131072)"),
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
            LargeOutput.Data->TryGetBoolField(TEXT("stderr_truncated"), bStdErrTruncated) && !bStdErrTruncated);
        TestTrue(TEXT("stdout dropped count is reported"),
            LargeOutput.Data->TryGetNumberField(TEXT("stdout_chars_dropped"), StdOutDropped) && StdOutDropped > 0);
        TestTrue(TEXT("stderr dropped count is reported"),
            LargeOutput.Data->TryGetNumberField(TEXT("stderr_chars_dropped"), StdErrDropped) && StdErrDropped == 0);
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

    // Deleting the request-global name must still resolve to the bounded print
    // installed in the private built-ins copy, never CPython's real print.
    const FHaybaHandlerResult DeletedPrintConversion = RunPolicyProbe(
        Handler,
        TEXT("class HostileAfterDelete:\n"
             "    def __str__(self):\n"
             "        raise RuntimeError('real builtin print escaped the bounded capture')\n"
             "del print\n"
             "print(HostileAfterDelete())"),
        true);
    if (TestTrue(TEXT("deleted print fallback is contained"), DeletedPrintConversion.bOk)
        && TestTrue(TEXT("deleted print fallback has data"), DeletedPrintConversion.Data.IsValid()))
    {
        TestTrue(TEXT("deleted print fallback completes without invoking __str__"),
            DeletedPrintConversion.Data->GetBoolField(TEXT("ok")));
        TestTrue(TEXT("deleted print fallback remains primitive-only"),
            DeletedPrintConversion.Data->GetStringField(TEXT("stdout"))
                .Contains(TEXT("non-primitive value omitted by bounded capture")));
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
