#include "HaybaMCPPythonHandler.h"
#include "HaybaMCPSettings.h"
#include "IPythonScriptPlugin.h"
#include "PythonScriptTypes.h"
#include "Misc/Base64.h"
#include "Dom/JsonObject.h"
#if PLATFORM_WINDOWS
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER for the SEH guard below
#endif

namespace
{
    constexpr int32 MaxPythonScriptChars = 256 * 1024;
    constexpr double MaxPythonExecutionSeconds = 5.0;
    constexpr int32 PythonDeadlineCheckInterval = 256;

    // Operations whose failure happens outside Python exception handling (or
    // outside this command entirely). `allow_unsafe` intentionally does NOT
    // bypass these: it grants filesystem/subprocess access, not permission to
    // tear down GWorld mid-tick, deadlock the command socket, or leave native
    // callbacks pointing at collected Python objects.
    struct FFatalPythonRule
    {
        const TCHAR* Pattern;
        const TCHAR* PolicyCode;
        const TCHAR* Reason;
        const TCHAR* Alternative;
    };

    const TArray<FFatalPythonRule>& FatalPythonRules()
    {
        static const TArray<FFatalPythonRule> Rules = {
            { TEXT("set_lod_build_settings"), TEXT("HCR-STATICMESH-001"), TEXT("is a known static-mesh editor crash"), TEXT("use GeometryScript and copy_mesh_to_static_mesh") },
            { TEXT("build_scale3d"), TEXT("HCR-STATICMESH-001"), TEXT("is a known static-mesh editor crash"), TEXT("use GeometryScript transform_mesh and rebuild geometry") },
            { TEXT("new_blank_map"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT("new_map_from_template"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT("editorloadingandsavingutils.load_map"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT("editorlevellibrary.load_level"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT("leveleditorsubsystem().new_level"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT("leveleditorsubsystem().load_level"), TEXT("HCR-WORLD-001"), TEXT("switches GWorld during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT(".load_map("), TEXT("HCR-WORLD-001"), TEXT("can switch GWorld through an aliased editor API during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT(".load_level("), TEXT("HCR-WORLD-001"), TEXT("can switch GWorld through an aliased editor API during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT(".new_level("), TEXT("HCR-WORLD-001"), TEXT("can replace GWorld through an aliased editor API during the MCP command tick"), TEXT("use a deferred typed editor map command outside python_run") },
            { TEXT(".set_list_items("), TEXT("HCR-UI-001"), TEXT("can submit duplicate UObject identities to a ListView and trigger the Slate SListView.h:1154 fatal assertion on refresh"), TEXT("use a typed ListView handler that validates unique UObject identities before applying items") },
            { TEXT(".bp_set_list_items("), TEXT("HCR-UI-001"), TEXT("can submit duplicate UObject identities to a ListView and trigger the Slate SListView.h:1154 fatal assertion on refresh"), TEXT("use a typed ListView handler that validates unique UObject identities before applying items") },
            { TEXT(".add_item("), TEXT("HCR-UI-001"), TEXT("can add the same UObject identity to a ListView more than once and trigger the Slate SListView.h:1154 fatal assertion on refresh"), TEXT("use a typed ListView handler that checks identity uniqueness before adding an item") },
            { TEXT("set_editor_property('list_items'"), TEXT("HCR-UI-001"), TEXT("bypasses ListView item identity validation and can trigger the Slate SListView.h:1154 fatal assertion"), TEXT("use a typed ListView handler that validates unique UObject identities before applying items") },
            { TEXT("unreal.register_"), TEXT("HCR-LIFE-001"), TEXT("registers an engine-lifetime callback whose Python target is collected after this request"), TEXT("perform the work inline or implement a native handler with owned delegate lifetime") },
            { TEXT(".add_callable("), TEXT("HCR-LIFE-001"), TEXT("binds a Python callable beyond the one-shot namespace lifetime"), TEXT("perform the work inline or use a native handler that owns and unbinds the delegate") },
            { TEXT(".add_callable_unique("), TEXT("HCR-LIFE-001"), TEXT("binds a Python callable beyond the one-shot namespace lifetime"), TEXT("perform the work inline or use a native handler that owns and unbinds the delegate") },
            { TEXT(".bind_callable("), TEXT("HCR-LIFE-001"), TEXT("binds a Python callable beyond the one-shot namespace lifetime"), TEXT("perform the work inline or use a native handler that owns and unbinds the delegate") },
            { TEXT(".add_function("), TEXT("HCR-LIFE-001"), TEXT("can bind behavior beyond the one-shot namespace lifetime"), TEXT("use a native handler that owns and unbinds the delegate") },
            { TEXT(".bind_function("), TEXT("HCR-LIFE-001"), TEXT("can bind behavior beyond the one-shot namespace lifetime"), TEXT("use a native handler that owns and unbinds the delegate") },
            { TEXT("set_timer("), TEXT("HCR-LIFE-001"), TEXT("schedules a callback after the one-shot namespace is released"), TEXT("use an owned native ticker/job that unregisters on shutdown") },
            { TEXT("threading.thread"), TEXT("HCR-LIFE-001"), TEXT("runs Unreal Python work off the game thread and outlives the request"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("threading.timer"), TEXT("HCR-LIFE-001"), TEXT("schedules Python after the request namespace is released"), TEXT("use an owned native ticker/job that unregisters on shutdown") },
            { TEXT("_thread.start_new_thread"), TEXT("HCR-LIFE-001"), TEXT("runs Unreal Python work off the game thread and outlives the request"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("asyncio.create_task"), TEXT("HCR-LIFE-001"), TEXT("leaves asynchronous Python work after the one-shot namespace is collected"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("asyncio.ensure_future"), TEXT("HCR-LIFE-001"), TEXT("leaves asynchronous Python work after the one-shot namespace is collected"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("run_in_executor("), TEXT("HCR-LIFE-001"), TEXT("runs Python work beyond the request and potentially off the game thread"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("concurrent.futures"), TEXT("HCR-LIFE-001"), TEXT("runs Python work beyond the request and potentially off the game thread"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("multiprocessing."), TEXT("HCR-LIFE-001"), TEXT("starts process-owned work beyond the MCP request lifetime"), TEXT("use a separately managed external job rather than python_run") },
            { TEXT("importmultiprocessing"), TEXT("HCR-LIFE-001"), TEXT("imports process-owned work that can outlive the request under aliases"), TEXT("use a separately managed external job rather than python_run") },
            { TEXT("fromthreadingimportthread"), TEXT("HCR-LIFE-001"), TEXT("imports an unmanaged thread constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("fromthreadingimporttimer"), TEXT("HCR-LIFE-001"), TEXT("imports an unmanaged timer constructor under an arbitrary local name"), TEXT("use an owned native ticker/job that unregisters on shutdown") },
            { TEXT("fromasyncioimportcreate_task"), TEXT("HCR-LIFE-001"), TEXT("imports an asynchronous task constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("fromasyncioimportensure_future"), TEXT("HCR-LIFE-001"), TEXT("imports an asynchronous task constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("importthreadingas"), TEXT("HCR-LIFE-001"), TEXT("imports unmanaged thread/timer constructors under an alias"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("importasyncioas"), TEXT("HCR-LIFE-001"), TEXT("imports task constructors under an alias that can outlive the request"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("importconcurrent.futuresas"), TEXT("HCR-LIFE-001"), TEXT("imports executors under an alias that can run beyond the request"), TEXT("use a separately managed external job") },
            { TEXT("time.sleep("), TEXT("HCR-BLOCK-001"), TEXT("blocks the editor game thread"), TEXT("return a job id and poll from the client instead of sleeping") },
            { TEXT("fromtimeimportsleep"), TEXT("HCR-BLOCK-001"), TEXT("imports a blocking sleep primitive under an arbitrary local name"), TEXT("return a job id and poll from the client instead of sleeping") },
            { TEXT("importtimeas"), TEXT("HCR-BLOCK-001"), TEXT("aliases the blocking sleep primitive beyond reliable source preflight"), TEXT("use bounded engine time queries or do timing in the Node process") },
            { TEXT("socket.socket("), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded network I/O on the editor game thread"), TEXT("perform network I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("socket.create_connection("), TEXT("HCR-BLOCK-001"), TEXT("opens blocking network I/O on the editor game thread"), TEXT("perform network I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("fromsocketimportsocket"), TEXT("HCR-BLOCK-001"), TEXT("imports a blocking socket constructor under an arbitrary local name"), TEXT("perform network I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("fromsocketimportcreate_connection"), TEXT("HCR-BLOCK-001"), TEXT("imports a blocking connection helper under an arbitrary local name"), TEXT("perform network I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("importsocketas"), TEXT("HCR-BLOCK-001"), TEXT("aliases blocking network I/O beyond reliable source preflight"), TEXT("perform network I/O in the Node MCP process") },
            { TEXT("requests."), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded HTTP I/O on the editor game thread"), TEXT("perform HTTP I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("importrequestsas"), TEXT("HCR-BLOCK-001"), TEXT("imports unbounded HTTP I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("urllib.request"), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded HTTP I/O on the editor game thread"), TEXT("perform HTTP I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("importurllibas"), TEXT("HCR-BLOCK-001"), TEXT("imports unbounded network I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("http.client"), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded HTTP I/O on the editor game thread"), TEXT("perform HTTP I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("importhttp.clientas"), TEXT("HCR-BLOCK-001"), TEXT("imports unbounded HTTP I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("httpx."), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded HTTP I/O on the editor game thread"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("importhttpxas"), TEXT("HCR-BLOCK-001"), TEXT("imports unbounded HTTP I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("aiohttp."), TEXT("HCR-BLOCK-001"), TEXT("allows asynchronous network I/O that can outlive the request"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("importaiohttpas"), TEXT("HCR-BLOCK-001"), TEXT("imports asynchronous network I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("urllib3."), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded HTTP I/O on the editor game thread"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("importurllib3as"), TEXT("HCR-BLOCK-001"), TEXT("imports unbounded HTTP I/O under an alias"), TEXT("perform HTTP I/O in the Node MCP process") },
            { TEXT("urlopen("), TEXT("HCR-BLOCK-001"), TEXT("allows unbounded network I/O on the editor game thread"), TEXT("perform network I/O in the Node MCP process, then pass validated data to a typed command") },
            { TEXT("builtins.input("), TEXT("HCR-BLOCK-001"), TEXT("waits for stdin that an unattended editor cannot provide"), TEXT("request input through the MCP user-prompt tool before python_run") },
            { TEXT("frombuiltinsimportinput"), TEXT("HCR-BLOCK-001"), TEXT("imports blocking stdin under an arbitrary local name"), TEXT("request input through the MCP user-prompt tool before python_run") },
            { TEXT("input("), TEXT("HCR-BLOCK-001"), TEXT("waits for stdin that an unattended editor cannot provide"), TEXT("request input through the MCP user-prompt tool before python_run") },
            { TEXT("breakpoint("), TEXT("HCR-BLOCK-001"), TEXT("enters an interactive debugger on the editor game thread"), TEXT("log bounded diagnostics and return them to the caller") },
            { TEXT("whiletrue"), TEXT("HCR-BLOCK-001"), TEXT("is an unbounded loop on the editor game thread"), TEXT("use a bounded loop or an owned incremental job") },
            { TEXT("while(true)"), TEXT("HCR-BLOCK-001"), TEXT("is an unbounded loop on the editor game thread"), TEXT("use a bounded loop or an owned incremental job") },
            { TEXT("while1"), TEXT("HCR-BLOCK-001"), TEXT("is an unbounded loop on the editor game thread"), TEXT("use a bounded loop or an owned incremental job") },
            { TEXT("while(1)"), TEXT("HCR-BLOCK-001"), TEXT("is an unbounded loop on the editor game thread"), TEXT("use a bounded loop or an owned incremental job") },
            { TEXT("ctypes."), TEXT("HCR-NATIVE-001"), TEXT("exposes native memory outside Unreal/Python safety boundaries"), TEXT("add a typed native handler with validated inputs") },
            { TEXT("importctypes"), TEXT("HCR-NATIVE-001"), TEXT("imports native-memory access that can be aliased"), TEXT("add a typed native handler with validated inputs") },
            { TEXT("fromctypesimport"), TEXT("HCR-NATIVE-001"), TEXT("imports native-memory access under an arbitrary local name"), TEXT("add a typed native handler with validated inputs") },
            { TEXT("faulthandler._"), TEXT("HCR-NATIVE-001"), TEXT("accesses private fault-injection primitives that raise native process faults"), TEXT("remove the fault injection; use the disposable survival harness for guard tests") },
            { TEXT("os._exit"), TEXT("HCR-EXIT-001"), TEXT("terminates the editor process without cleanup"), TEXT("use the typed editor shutdown command") },
            { TEXT("._exit("), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor process through an aliased os module"), TEXT("use the typed editor shutdown command") },
            { TEXT("_exit("), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor process under an aliased import"), TEXT("use the typed editor shutdown command") },
            { TEXT("fromosimport_exit"), TEXT("HCR-EXIT-001"), TEXT("imports the direct process-termination primitive"), TEXT("use the typed editor shutdown command") },
            { TEXT("sys.exit("), TEXT("HCR-EXIT-001"), TEXT("raises process-exit control flow inside the embedded interpreter"), TEXT("return normally from python_run") },
            { TEXT("exit("), TEXT("HCR-EXIT-001"), TEXT("raises process-exit control flow inside the embedded interpreter"), TEXT("return normally from python_run") },
            { TEXT("quit("), TEXT("HCR-EXIT-001"), TEXT("raises process-exit control flow inside the embedded interpreter"), TEXT("return normally from python_run") },
            { TEXT("raisesystemexit"), TEXT("HCR-EXIT-001"), TEXT("raises process-exit control flow inside the embedded interpreter"), TEXT("return normally from python_run") },
            { TEXT("signal.raise_signal("), TEXT("HCR-EXIT-001"), TEXT("can deliver a fatal signal to the editor process"), TEXT("use the disposable survival harness for process-failure tests") },
            { TEXT(".raise_signal("), TEXT("HCR-EXIT-001"), TEXT("can deliver a fatal signal through an aliased signal module"), TEXT("use the disposable survival harness for process-failure tests") },
            { TEXT("fromsignalimportraise_signal"), TEXT("HCR-EXIT-001"), TEXT("imports a signal primitive under an arbitrary local name"), TEXT("use the disposable survival harness for process-failure tests") },
            { TEXT("os.kill("), TEXT("HCR-EXIT-001"), TEXT("can deliver a fatal signal to the editor process"), TEXT("use the disposable survival harness for process-failure tests") },
            { TEXT("fromosimportkill"), TEXT("HCR-EXIT-001"), TEXT("imports a process-signal primitive under an arbitrary local name"), TEXT("use the disposable survival harness for process-failure tests") },
            { TEXT("request_exit("), TEXT("HCR-EXIT-001"), TEXT("requests editor process termination from inside an in-flight command"), TEXT("use the typed editor shutdown command") },
            { TEXT("quit_editor("), TEXT("HCR-EXIT-001"), TEXT("requests editor shutdown from inside an in-flight command"), TEXT("use the typed editor shutdown command") },
            { TEXT("taskkill"), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor through a subprocess despite the Tier-3 grant"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("pkill"), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor through a subprocess despite the Tier-3 grant"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("kill-9"), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor through a subprocess despite the Tier-3 grant"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("stop-process"), TEXT("HCR-EXIT-001"), TEXT("can terminate the editor through a subprocess despite the Tier-3 grant"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("execute_console_command("), TEXT("HCR-CONSOLE-001"), TEXT("can execute fatal, blocking, world-switch, or shutdown console commands outside typed policy"), TEXT("use editor_run_console_command for audited commands or a typed MCP tool") },
            { TEXT("fromunrealimportexecute_console_command"), TEXT("HCR-CONSOLE-001"), TEXT("imports unaudited console execution under an arbitrary local name"), TEXT("use editor_run_console_command for audited commands or a typed MCP tool") },
            { TEXT("exec("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct and execute a crash primitive that source preflight cannot inspect"), TEXT("write the intended operations directly in the submitted script") },
            { TEXT("eval("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct and execute a crash primitive that source preflight cannot inspect"), TEXT("write the intended expression directly without dynamic evaluation") },
            { TEXT("compile("), TEXT("HCR-DYNAMIC-001"), TEXT("can hide code from the non-bypassable crash preflight"), TEXT("submit the intended operations as ordinary source") },
            { TEXT("__import__("), TEXT("HCR-DYNAMIC-001"), TEXT("can dynamically import crash/process primitives hidden from preflight"), TEXT("use ordinary imports so policy can inspect the module") },
            { TEXT("importlib."), TEXT("HCR-DYNAMIC-001"), TEXT("can dynamically import crash/process primitives hidden from preflight"), TEXT("use ordinary imports so policy can inspect the module") },
            { TEXT("getattr("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct a fatal attribute lookup that source preflight cannot identify"), TEXT("call the intended inspected API directly by name") },
            { TEXT("setattr("), TEXT("HCR-DYNAMIC-001"), TEXT("can tamper with deadline or engine state through a dynamically selected attribute"), TEXT("assign an explicitly named, policy-visible property or use a typed handler") },
            { TEXT("delattr("), TEXT("HCR-DYNAMIC-001"), TEXT("can tamper with deadline or engine state through a dynamically selected attribute"), TEXT("use an explicitly named, policy-visible operation or a typed handler") },
            { TEXT(".__dict__"), TEXT("HCR-DYNAMIC-001"), TEXT("can retrieve and invoke crash or deadline primitives while hiding their callable spelling"), TEXT("call the intended inspected API directly by name") },
            { TEXT("globals("), TEXT("HCR-DYNAMIC-001"), TEXT("can retrieve and invoke hidden dynamic-execution primitives"), TEXT("refer to the intended inspected value directly") },
            { TEXT("locals("), TEXT("HCR-DYNAMIC-001"), TEXT("can retrieve and invoke hidden dynamic-execution primitives"), TEXT("refer to the intended inspected value directly") },
            { TEXT("vars("), TEXT("HCR-DYNAMIC-001"), TEXT("can retrieve and invoke hidden dynamic-execution primitives"), TEXT("refer to the intended inspected value directly") },
            { TEXT("frombuiltinsimportexec"), TEXT("HCR-DYNAMIC-001"), TEXT("imports dynamic execution under an arbitrary local name"), TEXT("write the intended operations directly") },
            { TEXT("frombuiltinsimporteval"), TEXT("HCR-DYNAMIC-001"), TEXT("imports dynamic evaluation under an arbitrary local name"), TEXT("write the intended expression directly") },
            { TEXT("frombuiltinsimportcompile"), TEXT("HCR-DYNAMIC-001"), TEXT("imports dynamic compilation under an arbitrary local name"), TEXT("submit ordinary source") },
            { TEXT("fromimportlibimportimport_module"), TEXT("HCR-DYNAMIC-001"), TEXT("imports dynamic module loading under an arbitrary local name"), TEXT("use ordinary imports so policy can inspect the module") },
            { TEXT("sys.settrace("), TEXT("HCR-TIME-001"), TEXT("disables or replaces the cooperative execution deadline"), TEXT("leave the deadline hook intact and split long work into bounded requests") },
            { TEXT("settrace("), TEXT("HCR-TIME-001"), TEXT("disables or replaces the cooperative execution deadline"), TEXT("leave the deadline hook intact and split long work into bounded requests") },
            { TEXT("sys.setprofile("), TEXT("HCR-TIME-001"), TEXT("can replace execution instrumentation used to protect the game thread"), TEXT("leave runtime instrumentation intact and split long work into bounded requests") },
            { TEXT("setprofile("), TEXT("HCR-TIME-001"), TEXT("can replace execution instrumentation used to protect the game thread"), TEXT("leave runtime instrumentation intact and split long work into bounded requests") },
        };
        return Rules;
    }

    FString CompactPythonSource(const FString& Code)
    {
        FString Normalized = Code.Replace(TEXT("\\\r\n"), TEXT(""));
        Normalized.ReplaceInline(TEXT("\\\n"), TEXT(""));
        // Quote style has no semantic bearing on the policy key names. Fold it
        // so direct property writes cannot evade a single-quoted rule by using
        // the equivalent double-quoted Python spelling.
        Normalized.ReplaceInline(TEXT("\""), TEXT("'"));
        FString Out;
        Out.Reserve(Normalized.Len());
        for (const TCHAR Ch : Normalized)
        {
            if (Ch == TEXT('\r') || Ch == TEXT('\n'))
            {
                if (Out.IsEmpty() || Out[Out.Len() - 1] != TEXT(';')) Out.AppendChar(TEXT(';'));
            }
            else if (!FChar::IsWhitespace(Ch))
            {
                Out.AppendChar(FChar::ToLower(Ch));
            }
        }
        return Out;
    }

    bool CompactContainsPolicyPattern(const FString& Compact, const FString& Pattern)
    {
        // Bare callable names need a token boundary. A plain substring check
        // makes `set_input()` look like the blocking builtin `input()` and
        // `.recompile()` look like dynamic `compile()`.
        const bool bNeedsCallableBoundary = Pattern.EndsWith(TEXT("("))
            && !Pattern.StartsWith(TEXT("."))
            && !Pattern.LeftChop(1).Contains(TEXT("."));
        int32 SearchFrom = 0;
        while (SearchFrom <= Compact.Len() - Pattern.Len())
        {
            const int32 Index = Compact.Find(
                Pattern,
                ESearchCase::CaseSensitive,
                ESearchDir::FromStart,
                SearchFrom);
            if (Index == INDEX_NONE) return false;
            if (!bNeedsCallableBoundary || Index == 0)
            {
                return true;
            }
            const TCHAR Previous = Compact[Index - 1];
            if (!FChar::IsAlnum(Previous) && Previous != TEXT('_') && Previous != TEXT('.'))
            {
                return true;
            }
            SearchFrom = Index + 1;
        }
        return false;
    }

    bool FindFatalPythonPattern(
        const FString& Code,
        FString& OutPattern,
        FString& OutPolicyCode,
        FString& OutReason,
        FString& OutAlternative)
    {
        // Patterns are whitespace-free lowercase and are matched against a
        // compacted source string. This closes trivial `time . sleep (` /
        // `while ( True )` variants; the C++ boundary remains authoritative
        // even when the TS validator or allow_unsafe is bypassed.
        const FString Compact = CompactPythonSource(Code);
        for (const FFatalPythonRule& Rule : FatalPythonRules())
        {
            if (CompactContainsPolicyPattern(Compact, Rule.Pattern))
            {
                OutPattern = Rule.Pattern;
                OutPolicyCode = Rule.PolicyCode;
                OutReason = Rule.Reason;
                OutAlternative = Rule.Alternative;
                return true;
            }
        }

        const bool bConnect = Compact.Contains(TEXT(".connect"));
        const bool bLoopback = Compact.Contains(TEXT("127.0.0.1"))
            || Compact.Contains(TEXT("localhost"))
            || Compact.Contains(TEXT("::1"));
        if (bConnect && bLoopback)
        {
            for (int32 Port = 52342; Port <= 52350; ++Port)
            {
                if (Compact.Contains(FString::FromInt(Port)))
                {
                    OutPattern = TEXT("loopback MCP socket connection");
                    OutPolicyCode = TEXT("HCR-BLOCK-001");
                    OutReason = TEXT("deadlocks by waiting on the game thread currently executing python_run");
                    OutAlternative = TEXT("call the intended unreal.* API directly or return and make a separate MCP request");
                    return true;
                }
            }
        }
        return false;
    }

    bool ShouldBlockTier3(
        const EPythonTier Tier,
        const bool bSettingAllows,
        const bool bAllowUnsafeOverride)
    {
        return Tier == EPythonTier::Unsafe
            && !bSettingAllows
            && !bAllowUnsafeOverride;
    }
}

// Run one Python command under Structured Exception Handling so a NATIVE access
// violation inside CPython / the UE Python bindings (a stale or GC'd UObject, a
// destroyed actor handle, re-entrant editor mutation) is converted into a
// recoverable error instead of taking down the whole editor. The Python-level
// try/except in the script wrapper cannot catch a C-level AV — only SEH can.
//
// This MUST be its own function with ONLY trivially-destructible params (raw
// pointers + a bool&): MSVC forbids __try/__except in any function that needs
// C++ object unwinding (C2712), and the handler is full of FString locals — and
// even a TFunctionRef parameter trips it. After a caught AV the interpreter may
// be degraded, so the caller stops and returns rather than issuing follow-ups.
static bool ExecPythonGuarded(IPythonScriptPlugin* Plugin, FPythonCommandEx* Cmd, bool& bOutCrashed)
{
    bOutCrashed = false;
#if PLATFORM_WINDOWS
    // Keep the result in a trivially-destructible local and return AFTER the __try.
    // MSVC 14.50+ raises C2712 if a `return <call>;` lives inside __try (the
    // returned-value construction counts as object unwinding); the older 14.44
    // toolchain did not. Capturing to a bool first sidesteps it without changing
    // the SEH guard's behaviour.
    bool bResult = false;
    __try
    {
        bResult = Plugin->ExecPythonCommandEx(*Cmd);
    }
    __except (EXCEPTION_EXECUTE_HANDLER)
    {
        bOutCrashed = true;
        bResult = false;
    }
    return bResult;
#else
    return Plugin->ExecPythonCommandEx(*Cmd);
#endif
}

TArray<FString> FHaybaMCPPythonHandler::GetCommands() const
{
    return { TEXT("python_run") };
}

#if WITH_DEV_AUTOMATION_TESTS
TArray<TPair<FString, FString>> FHaybaMCPPythonHandler::FatalPolicyCasesForTests()
{
    TArray<TPair<FString, FString>> Cases;
    Cases.Reserve(FatalPythonRules().Num() + 1);
    for (const FFatalPythonRule& Rule : FatalPythonRules())
    {
        Cases.Emplace(FString(Rule.Pattern), FString(Rule.PolicyCode));
    }
    Cases.Emplace(TEXT("client.connect(('::1', 52350))"), TEXT("HCR-BLOCK-001"));
    return Cases;
}

bool FHaybaMCPPythonHandler::MatchFatalPolicyForTests(const FString& Script, FString& OutPolicyCode)
{
    FString Pattern;
    FString Reason;
    FString Alternative;
    return FindFatalPythonPattern(Script, Pattern, OutPolicyCode, Reason, Alternative);
}

bool FHaybaMCPPythonHandler::IsTier3PolicyBlockedForTests(
    const FString& Script,
    const bool bSettingAllows,
    const bool bAllowUnsafeOverride)
{
    return ShouldBlockTier3(
        ClassifyScript(Script),
        bSettingAllows,
        bAllowUnsafeOverride);
}
#endif

EPythonTier FHaybaMCPPythonHandler::ClassifyScript(const FString& Code)
{
    static const TArray<FString> Tier3Keywords = {
        TEXT("subprocess"), TEXT("os.system"), TEXT("os.popen"),
        TEXT("open("), TEXT("__import__"), TEXT("eval("),
        TEXT("compile("), TEXT("shutil"),
        // NOTE: a bare "socket" pattern false-positived on UE's StaticMesh
        // "sockets" property (live-battery finding: mesh_get_sockets was
        // Tier-3 blocked). Match actual network-socket usage instead.
        TEXT("import socket"), TEXT("socket.socket")
    };
    static const TArray<FString> Tier2Keywords = {
        TEXT("spawn_actor"), TEXT("destroy_actor"), TEXT("set_property"),
        TEXT("create_asset"), TEXT("delete_asset"), TEXT(".save_"),
        TEXT("EditorAssetLibrary"), TEXT("EditorActorSubsystem")
    };

    // Tier policy must not be bypassable by `SubProcess . Popen` or mixed
    // case. Use the same compact representation as the fatal boundary.
    const FString Compact = CompactPythonSource(Code);

    for (const FString& K : Tier3Keywords)
    {
        if (Compact.Contains(CompactPythonSource(K))) return EPythonTier::Unsafe;
    }
    for (const FString& K : Tier2Keywords)
    {
        if (Compact.Contains(CompactPythonSource(K))) return EPythonTier::Mutation;
    }
    return EPythonTier::ReadOnly;
}

FHaybaHandlerResult FHaybaMCPPythonHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("python_run"))
    {
        return Run(Params);
    }
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("Unknown python command: %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPPythonHandler::Run(const TSharedPtr<FJsonObject>& P)
{
    // Validate required param
    FString Code;
    if (!P.IsValid() || !P->TryGetStringField(TEXT("script"), Code) || Code.IsEmpty())
    {
        return FHaybaHandlerResult::Err(TEXT("Missing required parameter: script"));
    }
    if (Code.Len() > MaxPythonScriptChars)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [HCR-SIZE-001]: matched 'script_size'; script is %d characters and the limit is %d. Safe alternative: split the work into bounded requests. Retry unchanged: forbidden."),
            Code.Len(), MaxPythonScriptChars));
    }

    FString FatalPattern;
    FString FatalPolicyCode;
    FString FatalReason;
    FString FatalAlternative;
    if (FindFatalPythonPattern(Code, FatalPattern, FatalPolicyCode, FatalReason, FatalAlternative))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [%s]: matched '%s', which %s. Safe alternative: %s. Retry unchanged: forbidden. allow_unsafe only overrides filesystem/subprocess policy; it never overrides an editor-crash or deadlock guard."),
            *FatalPolicyCode, *FatalPattern, *FatalReason, *FatalAlternative));
    }

    // Optional per-call unsafe override
    bool bAllowUnsafeOverride = false;
    P->TryGetBoolField(TEXT("allow_unsafe"), bAllowUnsafeOverride);

    // Classify
    EPythonTier Tier = ClassifyScript(Code);

    // Block Tier 3 if not allowed
    if (Tier == EPythonTier::Unsafe)
    {
        const bool bSettingAllows = FHaybaMCPSettings::Get().bAllowUnsafePython;
        if (ShouldBlockTier3(Tier, bSettingAllows, bAllowUnsafeOverride))
        {
            return FHaybaHandlerResult::Err(TEXT(
                "python_run policy_blocked [HCR-SANDBOX-001]: matched 'tier_3_filesystem_or_subprocess'. "
                "Filesystem and subprocess access is disabled. Safe alternative: use a typed MCP tool, or explicitly "
                "enable AllowUnsafePython / pass allow_unsafe:true after reviewing the script. Retry unchanged: forbidden; "
                "retry with the explicit unsafe grant is permitted. Crash, deadline, and deadlock guards remain non-bypassable."));
        }
    }

    // Check Python plugin
    IPythonScriptPlugin* PythonPlugin = IPythonScriptPlugin::Get();
    if (!PythonPlugin)
    {
        return FHaybaHandlerResult::Err(TEXT("Python plugin not loaded — enable the PythonScriptPlugin in your project"));
    }

    // Capture stdout/stderr. ExecuteStatement mode sends print() to the editor's
    // Python log, NOT to CommandResult (which only carries a last-expression repr
    // in Evaluate mode) — so the old code always returned "None". We redirect
    // sys.stdout/stderr into buffers stashed on a module global, run the user
    // code indented under a try/finally, then read the buffers back with a
    // second Evaluate call in the same interpreter. The user's own code was
    // already tier-classified above; this wrapper's machinery is internal and
    // intentionally not re-classified.
    // Base64-encode the user script so it embeds in the wrapper with zero
    // escaping/indentation hazards; the wrapper decodes it and exec()s it.
    FTCHARToUTF8 CodeUtf8(*Code);
    const FString CodeB64 = FBase64::Encode(reinterpret_cast<const uint8*>(CodeUtf8.Get()), CodeUtf8.Length());

    // ExecPythonCommandEx does NOT share a namespace between calls, but the
    // `builtins` module is a process-global singleton — so we stash the captured
    // output there in the run call and read it back in follow-up Evaluate calls.
    // Results come back base64-encoded so arbitrary stdout (newlines, quotes,
    // unicode) survives the repr round-trip losslessly.
    FString Wrapper;
    // UE's embedded print() bypasses sys.stdout (routes to the UE log via a
    // C-level writer), so redirecting sys.stdout captures nothing. Instead we
    // inject a capturing print() straight into the user code's exec globals.
    // Globals shadow builtins during name resolution, so the user's print()
    // resolves to ours WITHOUT ever mutating the process-global builtins.print
    // (mutating it leaked a stale override across runs). Results are stashed on
    // builtins (a shared singleton) and read back base64-encoded.
    Wrapper += TEXT("import io as _hb_io, traceback as _hb_tb, builtins as _hb_b, base64 as _hb_64, sys as _hb_sys, time as _hb_time\n");
    Wrapper += FString::Printf(TEXT("_hb_src = _hb_64.b64decode('%s').decode('utf-8')\n"), *CodeB64);
    Wrapper += TEXT("_hb_out = _hb_io.StringIO(); _hb_err = _hb_io.StringIO()\n");
    Wrapper += TEXT("def _hb_print(*a, **k):\n");
    Wrapper += TEXT("    _sep = k.get('sep', ' '); _end = k.get('end', '\\n'); _f = k.get('file', None)\n");
    Wrapper += TEXT("    _line = _sep.join([str(_x) for _x in a]) + _end\n");
    Wrapper += TEXT("    (_hb_err if _f is not None else _hb_out).write(_line)\n");
    Wrapper += TEXT("_hb_g = {'print': _hb_print, '__name__': '__main__'}\n");
    Wrapper += TEXT("_hb_ok = True\n");
    Wrapper += TEXT("_hb_timed_out = False\n");
    Wrapper += FString::Printf(TEXT("_hb_deadline = _hb_time.monotonic() + %.3f\n"), MaxPythonExecutionSeconds);
    Wrapper += TEXT("_hb_trace_events = 0\n");
    Wrapper += TEXT("class _HaybaDeadlineExceeded(RuntimeError):\n");
    Wrapper += TEXT("    pass\n");
    Wrapper += TEXT("def _hb_trace(_frame, _event, _arg):\n");
    Wrapper += TEXT("    global _hb_trace_events\n");
    Wrapper += TEXT("    _hb_trace_events += 1\n");
    Wrapper += FString::Printf(TEXT("    if (_hb_trace_events %% %d) == 0 and _hb_time.monotonic() >= _hb_deadline:\n"), PythonDeadlineCheckInterval);
    Wrapper += FString::Printf(TEXT("        raise _HaybaDeadlineExceeded('python_run exceeded %.1f second cooperative bytecode deadline')\n"), MaxPythonExecutionSeconds);
    Wrapper += TEXT("    return _hb_trace\n");
    Wrapper += TEXT("try:\n");
    Wrapper += TEXT("    _hb_sys.settrace(_hb_trace)\n");
    Wrapper += TEXT("    exec(compile(_hb_src, '<hayba>', 'exec'), _hb_g)\n");
    Wrapper += TEXT("except _HaybaDeadlineExceeded as _hb_timeout_error:\n");
    Wrapper += TEXT("    _hb_ok = False\n");
    Wrapper += TEXT("    _hb_timed_out = True\n");
    Wrapper += TEXT("    _hb_err.write(str(_hb_timeout_error))\n");
    // Catch BaseException so SystemExit/KeyboardInterrupt cannot escape the
    // one-shot command even if a future alias slips past source preflight.
    Wrapper += TEXT("except BaseException:\n");
    Wrapper += TEXT("    _hb_ok = False\n");
    Wrapper += TEXT("    _hb_err.write(_hb_tb.format_exc())\n");
    Wrapper += TEXT("finally:\n");
    Wrapper += TEXT("    _hb_sys.settrace(None)\n");
    Wrapper += TEXT("_hb_b._hayba_out = _hb_out.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_err = _hb_err.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_ok = _hb_ok\n");
    Wrapper += TEXT("_hb_b._hayba_timed_out = _hb_timed_out\n");
    // Eagerly drop the script's exec namespace and force a CPython collection
    // WHILE STILL INSIDE the SEH-guarded ExecPythonCommandEx below. This targets
    // the python311 -> PythonScriptPlugin -> CoreUObject access-violation class:
    // a one-shot script creates a Python wrapper for a UObject it spawns/edits,
    // that UObject is later destroyed (or the wrapper otherwise dangles), and the
    // wrapper lingers in `_hb_g` long after Run() returns. CPython then collects
    // it on some LATER allocation/tick — outside any __try — and the stale
    // reference faults fatally (the engine had no chance to catch it). By clearing
    // `_hb_g` and calling gc.collect() here, the wrapper is finalised NOW, inside
    // the guard: if finalisation is going to fault it does so where the SEH guard
    // converts it to a recoverable error, and if it doesn't fault the dangling
    // reference is gone before the next engine GC can trip over it. Results were
    // already stashed on `builtins` (above), and the wrapper-local capture buffers
    // (_hb_out/_hb_err/_hb_ok) are NOT in `_hb_g`, so the readback is unaffected.
    // Wrapped in try/except so a degraded interpreter never turns cleanup into the
    // very failure we are guarding against.
    Wrapper += TEXT("try:\n");
    Wrapper += TEXT("    _hb_g.clear()\n");
    Wrapper += TEXT("    import gc as _hb_gc\n");
    Wrapper += TEXT("    _hb_gc.collect()\n");
    Wrapper += TEXT("except Exception:\n");
    Wrapper += TEXT("    pass\n");

    FPythonCommandEx RunCmd;
    RunCmd.Command = Wrapper;
    // ExecuteFile compiles in 'exec' mode (multi-statement). ExecuteStatement
    // uses 'single' mode and rejects our multi-line wrapper with
    // "SyntaxError: multiple statements found while compiling a single statement".
    RunCmd.ExecutionMode = EPythonCommandExecutionMode::ExecuteFile;
    // Guard the user-script execution against native access violations so a bad
    // script returns an error instead of crashing the editor.
    bool bRunCrashed = false;
    const bool bExecOk = ExecPythonGuarded(PythonPlugin, &RunCmd, bRunCrashed);
    if (bRunCrashed)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run fatal_error [HCR-NATIVE-002]: matched 'native_access_violation'. The script "
            "dereferenced an invalid object — typically a stale/destroyed actor or "
            "component handle, a garbage-collected UObject held across ticks, or a "
            "re-entrant editor mutation. The editor was kept alive by the SEH guard; "
            "safe alternative: re-acquire handles fresh inside the run (do not cache UObject "
            "references between python_run calls) and avoid mutating the level while iterating it. "
            "Retry unchanged: forbidden; verify editor health before any further mutation."));
    }

    // Evaluate a base64 expression and decode the result back to a string.
    // Guarded by SEH too: the user script may have left the interpreter in a
    // degraded state, so even this trivial readback can fault — better to lose
    // the captured stdout than to take down the editor.
    auto EvalB64 = [PythonPlugin](const FString& Attr, bool& bOutCrashed) -> FString
    {
        bOutCrashed = false;
        FPythonCommandEx E;
        E.Command = FString::Printf(
            TEXT("__import__('base64').b64encode((getattr(__import__('builtins'),'%s','') or '').encode('utf-8')).decode('ascii')"),
            *Attr);
        E.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
        ExecPythonGuarded(PythonPlugin, &E, bOutCrashed);
        if (bOutCrashed) return FString();
        FString R = E.CommandResult.TrimStartAndEnd();
        if (R.Len() >= 2 && (R.StartsWith(TEXT("'")) || R.StartsWith(TEXT("\""))))
        {
            R = R.Mid(1, R.Len() - 2);
        }
        TArray<uint8> Bytes;
        if (R.IsEmpty() || !FBase64::Decode(R, Bytes) || Bytes.Num() == 0) return FString();
        FUTF8ToTCHAR Conv(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), Bytes.Num());
        return FString(Conv.Length(), Conv.Get());
    };

    bool bStdOutReadCrashed = false;
    bool bStdErrReadCrashed = false;
    const FString StdOut = EvalB64(TEXT("_hayba_out"), bStdOutReadCrashed);
    const FString StdErr = EvalB64(TEXT("_hayba_err"), bStdErrReadCrashed);
    if (bStdOutReadCrashed || bStdErrReadCrashed)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run fatal_error [HCR-NATIVE-002]: matched 'post_execution_readback_access_violation'. "
            "The interpreter faulted while reading captured output after the user script. Safe alternative: "
            "restart the disposable editor before retrying, then remove stale UObject references and split the "
            "script into smaller typed operations. Retry unchanged: forbidden; editor session health is suspect."));
    }

    FPythonCommandEx OkCmd;
    OkCmd.Command = TEXT("repr(getattr(__import__('builtins'),'_hayba_ok',True))");
    OkCmd.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
    bool bOkReadCrashed = false;
    ExecPythonGuarded(PythonPlugin, &OkCmd, bOkReadCrashed);
    if (bOkReadCrashed)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run fatal_error [HCR-NATIVE-002]: matched 'post_execution_status_access_violation'. "
            "The interpreter faulted while reading completion state. Safe alternative: restart the disposable "
            "editor before retrying and replace stale UObject access with a typed handler. Retry unchanged: forbidden; "
            "editor session health is suspect."));
    }
    const bool bUserOk = !bOkReadCrashed && !OkCmd.CommandResult.Contains(TEXT("False"));

    FPythonCommandEx TimeoutCmd;
    TimeoutCmd.Command = TEXT("repr(getattr(__import__('builtins'),'_hayba_timed_out',False))");
    TimeoutCmd.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
    bool bTimeoutReadCrashed = false;
    ExecPythonGuarded(PythonPlugin, &TimeoutCmd, bTimeoutReadCrashed);
    if (bTimeoutReadCrashed)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run fatal_error [HCR-NATIVE-002]: matched 'post_execution_deadline_readback_access_violation'. "
            "The interpreter faulted while reading deadline state. Safe alternative: restart the disposable editor "
            "before retrying and split the script into bounded typed operations. Retry unchanged: forbidden; editor "
            "session health is suspect."));
    }
    const bool bTimedOut = !bTimeoutReadCrashed && TimeoutCmd.CommandResult.Contains(TEXT("True"));
    if (bTimedOut)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [HCR-TIME-001]: matched 'execution_deadline'; Python bytecode exceeded the %.1f second cooperative deadline. Safe alternative: split the work into bounded requests or implement an owned native job and poll it. Retry unchanged: forbidden. Native UE/C-extension calls cannot be interrupted safely and must be refused by preflight instead."),
            MaxPythonExecutionSeconds));
    }

    TSharedPtr<FJsonObject> Out = MakeShareable(new FJsonObject());
    Out->SetBoolField(TEXT("ok"), bExecOk && bUserOk);
    Out->SetNumberField(TEXT("tier"), static_cast<int32>(Tier));
    Out->SetStringField(TEXT("stdout"), StdOut);
    Out->SetStringField(TEXT("stderr"), StdErr);

    return FHaybaHandlerResult::Ok(Out);
}
