#include "HaybaMCPPythonHandler.h"
#include "IPythonScriptPlugin.h"
#include "PythonScriptTypes.h"
#include "Misc/Base64.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPSeh.h"   // world-switch repair after a swallowed fault
#if PLATFORM_WINDOWS
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER for the SEH guard below
#endif

namespace
{
    constexpr int32 MaxPythonScriptChars = 256 * 1024;
    constexpr int32 MaxPythonPolicyExpandedChars = MaxPythonScriptChars * 4;
    constexpr int32 MaxPythonPolicyPathChars = 4096;
    constexpr int32 MaxPythonPolicyPathComponents = 64;
    constexpr int32 MaxPythonPolicyAliasWorkChars = MaxPythonPolicyExpandedChars;
    constexpr int32 MaxPythonPolicyFStringDepth = 16;
    constexpr int32 MaxPythonPolicyTokens = MaxPythonScriptChars;
    constexpr int32 MaxPythonPolicyLexedChars = MaxPythonPolicyExpandedChars;
    constexpr int32 MaxPythonCapturedCharsPerStream = 64 * 1024;
    constexpr double MaxPythonExecutionSeconds = 5.0;
    constexpr int32 PythonDeadlineCheckInterval = 256;

    // Operations whose failure happens outside Python exception handling (or
    // outside this command entirely). `allow_unsafe` is a deprecated wire
    // compatibility field and is ineffective for every policy family.
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
            { TEXT("concurrent.futures.threadpoolexecutor("), TEXT("HCR-LIFE-001"), TEXT("runs Python work beyond the request and off the game thread"), TEXT("use a separately managed external job") },
            { TEXT("concurrent.futures.processpoolexecutor("), TEXT("HCR-LIFE-001"), TEXT("runs Python work beyond the request in child processes"), TEXT("use a separately managed external job") },
            { TEXT("multiprocessing."), TEXT("HCR-LIFE-001"), TEXT("starts process-owned work beyond the MCP request lifetime"), TEXT("use a separately managed external job rather than python_run") },
            { TEXT("importmultiprocessing"), TEXT("HCR-LIFE-001"), TEXT("imports process-owned work that can outlive the request under aliases"), TEXT("use a separately managed external job rather than python_run") },
            { TEXT("fromthreadingimportthread"), TEXT("HCR-LIFE-001"), TEXT("imports an unmanaged thread constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("fromthreadingimporttimer"), TEXT("HCR-LIFE-001"), TEXT("imports an unmanaged timer constructor under an arbitrary local name"), TEXT("use an owned native ticker/job that unregisters on shutdown") },
            { TEXT("fromasyncioimportcreate_task"), TEXT("HCR-LIFE-001"), TEXT("imports an asynchronous task constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("fromasyncioimportensure_future"), TEXT("HCR-LIFE-001"), TEXT("imports an asynchronous task constructor under an arbitrary local name"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("importthreadingas"), TEXT("HCR-LIFE-001"), TEXT("imports unmanaged thread/timer constructors under an alias"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("importasyncioas"), TEXT("HCR-LIFE-001"), TEXT("imports task constructors under an alias that can outlive the request"), TEXT("perform bounded work synchronously or add an owned native async job") },
            { TEXT("fromconcurrent.futuresimportthreadpoolexecutor"), TEXT("HCR-LIFE-001"), TEXT("imports an executor that can run beyond the request"), TEXT("use a separately managed external job") },
            { TEXT("fromconcurrent.futuresimportprocesspoolexecutor"), TEXT("HCR-LIFE-001"), TEXT("imports an executor that can run beyond the request"), TEXT("use a separately managed external job") },
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
            { TEXT("threading.lock("), TEXT("HCR-BLOCK-001"), TEXT("creates a lock whose acquire can block the editor game thread"), TEXT("use straight-line request-local state without blocking synchronization") },
            { TEXT("threading.rlock("), TEXT("HCR-BLOCK-001"), TEXT("creates a re-entrant lock whose acquire can block the editor game thread"), TEXT("use straight-line request-local state without blocking synchronization") },
            { TEXT("threading.event("), TEXT("HCR-BLOCK-001"), TEXT("creates an event whose wait can block the editor game thread"), TEXT("return an owned job id and poll from the client") },
            { TEXT("threading.condition("), TEXT("HCR-BLOCK-001"), TEXT("creates a condition whose wait can block the editor game thread"), TEXT("return an owned job id and poll from the client") },
            { TEXT("threading.semaphore("), TEXT("HCR-BLOCK-001"), TEXT("creates a semaphore whose acquire can block the editor game thread"), TEXT("use bounded request-local work without blocking synchronization") },
            { TEXT("threading.boundedsemaphore("), TEXT("HCR-BLOCK-001"), TEXT("creates a semaphore whose acquire can block the editor game thread"), TEXT("use bounded request-local work without blocking synchronization") },
            { TEXT("threading.lock.acquire("), TEXT("HCR-BLOCK-001"), TEXT("can block forever, including on a second non-reentrant acquire"), TEXT("avoid locks inside python_run and perform bounded work inline") },
            { TEXT("threading.rlock.acquire("), TEXT("HCR-BLOCK-001"), TEXT("can block the editor game thread while waiting for ownership"), TEXT("avoid locks inside python_run and perform bounded work inline") },
            { TEXT("threading.event.wait("), TEXT("HCR-BLOCK-001"), TEXT("waits on the editor game thread"), TEXT("return an owned job id and poll from the client") },
            { TEXT("threading.condition.wait("), TEXT("HCR-BLOCK-001"), TEXT("waits on the editor game thread"), TEXT("return an owned job id and poll from the client") },
            { TEXT("threading.semaphore.acquire("), TEXT("HCR-BLOCK-001"), TEXT("can wait indefinitely on the editor game thread"), TEXT("use bounded request-local work without blocking synchronization") },
            { TEXT("threading.boundedsemaphore.acquire("), TEXT("HCR-BLOCK-001"), TEXT("can wait indefinitely on the editor game thread"), TEXT("use bounded request-local work without blocking synchronization") },
            { TEXT("queue.queue("), TEXT("HCR-BLOCK-001"), TEXT("creates a queue whose get or join can block the editor game thread"), TEXT("pass bounded request data directly or poll an owned native job") },
            { TEXT("queue.queue.get("), TEXT("HCR-BLOCK-001"), TEXT("can wait indefinitely for queue data on the editor game thread"), TEXT("pass bounded request data directly or poll an owned native job") },
            { TEXT("queue.queue.join("), TEXT("HCR-BLOCK-001"), TEXT("can wait indefinitely for queue completion on the editor game thread"), TEXT("poll an owned native job from the client") },
            { TEXT("concurrent.futures.future.result("), TEXT("HCR-BLOCK-001"), TEXT("can wait indefinitely for a future on the editor game thread"), TEXT("return an owned job id and poll from the client") },
            { TEXT("concurrent.futures.wait("), TEXT("HCR-BLOCK-001"), TEXT("waits for futures on the editor game thread"), TEXT("return an owned job id and poll from the client") },
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
            { TEXT("taskkill"), TEXT("HCR-EXIT-001"), TEXT("attempts to terminate the editor through a forbidden host-process path"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("pkill"), TEXT("HCR-EXIT-001"), TEXT("attempts to terminate the editor through a forbidden host-process path"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("kill-9"), TEXT("HCR-EXIT-001"), TEXT("attempts to terminate the editor through a forbidden host-process path"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("stop-process"), TEXT("HCR-EXIT-001"), TEXT("attempts to terminate the editor through a forbidden host-process path"), TEXT("use the typed editor shutdown workflow") },
            { TEXT("execute_console_command("), TEXT("HCR-CONSOLE-001"), TEXT("can execute fatal, blocking, world-switch, or shutdown console commands outside typed policy"), TEXT("use editor_run_console_command for audited commands or a typed MCP tool") },
            { TEXT("fromunrealimportexecute_console_command"), TEXT("HCR-CONSOLE-001"), TEXT("imports unaudited console execution under an arbitrary local name"), TEXT("use editor_run_console_command for audited commands or a typed MCP tool") },
            { TEXT("exec("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct and execute a crash primitive that source preflight cannot inspect"), TEXT("write the intended operations directly in the submitted script") },
            { TEXT("eval("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct and execute a crash primitive that source preflight cannot inspect"), TEXT("write the intended expression directly without dynamic evaluation") },
            { TEXT("compile("), TEXT("HCR-DYNAMIC-001"), TEXT("can hide code from the non-bypassable crash preflight"), TEXT("submit the intended operations as ordinary source") },
            { TEXT("__import__("), TEXT("HCR-DYNAMIC-001"), TEXT("can dynamically import crash/process primitives hidden from preflight"), TEXT("use ordinary imports so policy can inspect the module") },
            { TEXT("importlib."), TEXT("HCR-DYNAMIC-001"), TEXT("can dynamically import crash/process primitives hidden from preflight"), TEXT("use ordinary imports so policy can inspect the module") },
            { TEXT("getattr("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct a fatal attribute lookup that source preflight cannot identify"), TEXT("call the intended inspected API directly by name") },
            { TEXT(".__getattribute__("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct a fatal attribute lookup while bypassing getattr policy"), TEXT("call the intended inspected API directly by name") },
            { TEXT("operator.attrgetter("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct a fatal attribute lookup from a runtime string"), TEXT("call the intended inspected API directly by name") },
            { TEXT("operator.methodcaller("), TEXT("HCR-DYNAMIC-001"), TEXT("can construct a fatal method call from a runtime string"), TEXT("call the intended inspected API directly by name") },
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

    enum class EPythonPolicyTokenKind : uint8
    {
        Identifier,
        Dot,
        OpenParen,
        CloseParen,
        Comma,
        Equal,
        Colon,
        Newline,
        Semicolon,
        Other,
    };

    struct FPythonPolicyToken
    {
        EPythonPolicyTokenKind Kind = EPythonPolicyTokenKind::Other;
        FString Text;
    };

    bool IsPythonIdentifierStart(const TCHAR Ch)
    {
        return Ch == TEXT('_') || FChar::IsAlpha(Ch);
    }

    bool IsPythonIdentifierContinuation(const TCHAR Ch)
    {
        return Ch == TEXT('_') || FChar::IsAlnum(Ch);
    }

    bool IsPythonStringPrefix(const FString& Prefix)
    {
        if (Prefix.IsEmpty() || Prefix.Len() > 3) return false;
        for (const TCHAR Ch : Prefix)
        {
            const TCHAR Lower = FChar::ToLower(Ch);
            if (Lower != TEXT('f') && Lower != TEXT('r')
                && Lower != TEXT('b') && Lower != TEXT('u'))
            {
                return false;
            }
        }
        return true;
    }

    /**
     * Return only expressions inside f-string replacement fields. Treating the
     * whole literal as source would false-positive on f"os.abort() is text";
     * ignoring it would let f"{os.abort()}" bypass the fatal boundary. This is
     * deliberately a conservative lexical extractor, not a Python evaluator.
     */
    FString ExtractPythonFStringExpressions(const FString& Code)
    {
        FString Expressions;
        Expressions.Reserve(FMath::Min(Code.Len(), MaxPythonPolicyExpandedChars));

        auto SkipQuoted = [&Code](int32& At)
        {
            const TCHAR Quote = Code[At];
            const bool bTriple = At + 2 < Code.Len()
                && Code[At + 1] == Quote && Code[At + 2] == Quote;
            At += bTriple ? 3 : 1;
            while (At < Code.Len())
            {
                if (Code[At] == TEXT('\\'))
                {
                    At = FMath::Min(At + 2, Code.Len());
                    continue;
                }
                if (bTriple)
                {
                    if (At + 2 < Code.Len() && Code[At] == Quote
                        && Code[At + 1] == Quote && Code[At + 2] == Quote)
                    {
                        At += 3;
                        return;
                    }
                }
                else if (Code[At] == Quote)
                {
                    ++At;
                    return;
                }
                ++At;
            }
        };

        int32 Index = 0;
        while (Index < Code.Len() && Expressions.Len() < MaxPythonPolicyExpandedChars)
        {
            if (Code[Index] == TEXT('#'))
            {
                while (Index < Code.Len() && Code[Index] != TEXT('\n') && Code[Index] != TEXT('\r')) ++Index;
                continue;
            }

            FString Prefix;
            int32 QuoteAt = Index;
            if (Code[Index] == TEXT('\'') || Code[Index] == TEXT('"'))
            {
                // An unprefixed string cannot contain evaluated replacement
                // fields, but it still has to be skipped as one lexical unit.
            }
            else if (IsPythonIdentifierStart(Code[Index]))
            {
                const int32 PrefixStart = Index;
                while (QuoteAt < Code.Len() && IsPythonIdentifierContinuation(Code[QuoteAt])) ++QuoteAt;
                Prefix = Code.Mid(PrefixStart, QuoteAt - PrefixStart);
                if (!IsPythonStringPrefix(Prefix)
                    || QuoteAt < 0 || QuoteAt >= Code.Len()
                    || (Code[QuoteAt] != TEXT('\'') && Code[QuoteAt] != TEXT('"')))
                {
                    Index = QuoteAt;
                    continue;
                }
            }
            else
            {
                ++Index;
                continue;
            }

            const TCHAR Quote = Code[QuoteAt];
            const bool bTriple = QuoteAt + 2 < Code.Len()
                && Code[QuoteAt + 1] == Quote && Code[QuoteAt + 2] == Quote;
            const bool bFString = Prefix.ToLower().Contains(TEXT("f"));
            int32 At = QuoteAt + (bTriple ? 3 : 1);
            while (At < Code.Len())
            {
                if (Code[At] == TEXT('\\'))
                {
                    At = FMath::Min(At + 2, Code.Len());
                    continue;
                }
                if (bTriple)
                {
                    if (At + 2 < Code.Len() && Code[At] == Quote
                        && Code[At + 1] == Quote && Code[At + 2] == Quote)
                    {
                        At += 3;
                        break;
                    }
                }
                else if (Code[At] == Quote)
                {
                    ++At;
                    break;
                }

                if (bFString && Code[At] == TEXT('{'))
                {
                    if (At + 1 < Code.Len() && Code[At + 1] == TEXT('{'))
                    {
                        At += 2;
                        continue;
                    }
                    const int32 ExpressionStart = ++At;
                    int32 Depth = 1;
                    while (At < Code.Len() && Depth > 0)
                    {
                        if (Code[At] == TEXT('\'') || Code[At] == TEXT('"'))
                        {
                            SkipQuoted(At);
                            continue;
                        }
                        if (Code[At] == TEXT('{')) ++Depth;
                        else if (Code[At] == TEXT('}')) --Depth;
                        ++At;
                    }
                    const int32 ExpressionEnd = Depth == 0 ? At - 1 : At;
                    const int32 Available = MaxPythonPolicyExpandedChars - Expressions.Len();
                    if (Available > 1)
                    {
                        Expressions += Code.Mid(
                            ExpressionStart,
                            FMath::Min(ExpressionEnd - ExpressionStart, Available - 1));
                        Expressions.AppendChar(TEXT(';'));
                    }
                    continue;
                }
                ++At;
            }
            Index = At;
        }
        return Expressions;
    }

    /**
     * Tokenize only the Python syntax needed by fatal-policy import resolution.
     * Comments and string literals are deliberately skipped: a warning or a
     * printed example containing "os.abort()" must not become executable policy
     * evidence. The older compact matcher still handles non-call structural
     * rules; aliases are resolved from this lexical stream instead of by
     * substring guesses.
     */
    struct FPythonPolicyLexBudget
    {
        int32 RemainingTokens = MaxPythonPolicyTokens;
        int32 RemainingChars = MaxPythonPolicyLexedChars;
        bool bExceeded = false;
    };

    void MarkPythonPolicyLexBudgetExceeded(
        TArray<FPythonPolicyToken>& Tokens,
        FPythonPolicyLexBudget& Budget)
    {
        Tokens.Reset();
        Tokens.Add({ EPythonPolicyTokenKind::Identifier, TEXT("__hayba_fstring_nesting_limit__") });
        Tokens.Add({ EPythonPolicyTokenKind::OpenParen, TEXT("(") });
        Budget.bExceeded = true;
    }

    void LexPythonPolicySourceInto(
        const FString& Code,
        TArray<FPythonPolicyToken>& Tokens,
        FPythonPolicyLexBudget& Budget,
        const int32 FStringDepth)
    {
        if (Budget.bExceeded) return;
        if (Code.Len() > Budget.RemainingChars)
        {
            MarkPythonPolicyLexBudgetExceeded(Tokens, Budget);
            return;
        }
        Budget.RemainingChars -= Code.Len();

        auto AddToken = [&Tokens, &Budget](FPythonPolicyToken&& Token) -> bool
        {
            if (Budget.RemainingTokens <= 0)
            {
                MarkPythonPolicyLexBudgetExceeded(Tokens, Budget);
                return false;
            }
            --Budget.RemainingTokens;
            Tokens.Add(MoveTemp(Token));
            return true;
        };

        int32 Index = 0;
        while (Index < Code.Len())
        {
            const TCHAR Ch = Code[Index];

            if (Ch == TEXT('\\') && Index + 1 < Code.Len()
                && (Code[Index + 1] == TEXT('\n') || Code[Index + 1] == TEXT('\r')))
            {
                ++Index;
                if (Index < Code.Len() && Code[Index] == TEXT('\r')) ++Index;
                if (Index < Code.Len() && Code[Index] == TEXT('\n')) ++Index;
                continue;
            }

            if (Ch == TEXT('#'))
            {
                while (Index < Code.Len() && Code[Index] != TEXT('\n') && Code[Index] != TEXT('\r')) ++Index;
                continue;
            }

            if (Ch == TEXT('\'') || Ch == TEXT('"'))
            {
                const TCHAR Quote = Ch;
                const bool bTriple = Index + 2 < Code.Len()
                    && Code[Index + 1] == Quote && Code[Index + 2] == Quote;
                Index += bTriple ? 3 : 1;
                while (Index < Code.Len())
                {
                    if (Code[Index] == TEXT('\\'))
                    {
                        Index = FMath::Min(Index + 2, Code.Len());
                        continue;
                    }
                    if (bTriple)
                    {
                        if (Index + 2 < Code.Len() && Code[Index] == Quote
                            && Code[Index + 1] == Quote && Code[Index + 2] == Quote)
                        {
                            Index += 3;
                            break;
                        }
                    }
                    else if (Code[Index] == Quote)
                    {
                        ++Index;
                        break;
                    }
                    ++Index;
                }
                continue;
            }

            if (IsPythonIdentifierStart(Ch))
            {
                const int32 Start = Index++;
                while (Index < Code.Len() && IsPythonIdentifierContinuation(Code[Index])) ++Index;
                if (!AddToken({
                    EPythonPolicyTokenKind::Identifier,
                    Code.Mid(Start, Index - Start).ToLower() })) return;
                continue;
            }

            EPythonPolicyTokenKind Kind = EPythonPolicyTokenKind::Other;
            switch (Ch)
            {
            case TEXT('.'): Kind = EPythonPolicyTokenKind::Dot; break;
            case TEXT('('): Kind = EPythonPolicyTokenKind::OpenParen; break;
            case TEXT(')'): Kind = EPythonPolicyTokenKind::CloseParen; break;
            case TEXT(','): Kind = EPythonPolicyTokenKind::Comma; break;
            case TEXT('='): Kind = EPythonPolicyTokenKind::Equal; break;
            case TEXT(':'): Kind = EPythonPolicyTokenKind::Colon; break;
            case TEXT(';'): Kind = EPythonPolicyTokenKind::Semicolon; break;
            case TEXT('\n'):
                Kind = EPythonPolicyTokenKind::Newline;
                break;
            case TEXT('\r'):
                Kind = EPythonPolicyTokenKind::Newline;
                if (Index + 1 < Code.Len() && Code[Index + 1] == TEXT('\n')) ++Index;
                break;
            default:
                if (FChar::IsWhitespace(Ch))
                {
                    ++Index;
                    continue;
                }
                break;
            }
            if (!AddToken({ Kind, FString::ChrN(1, Ch) })) return;
            ++Index;
        }

        const FString FStringExpressions = ExtractPythonFStringExpressions(Code);
        if (!FStringExpressions.IsEmpty())
        {
            if (!AddToken({ EPythonPolicyTokenKind::Semicolon, TEXT(";") })) return;
            if (FStringDepth >= MaxPythonPolicyFStringDepth)
            {
                // Fail closed instead of recursively tokenizing attacker-made
                // nested f-string-looking text until the editor stack blows.
                MarkPythonPolicyLexBudgetExceeded(Tokens, Budget);
            }
            else
            {
                LexPythonPolicySourceInto(
                    FStringExpressions,
                    Tokens,
                    Budget,
                    FStringDepth + 1);
            }
        }
    }

    TArray<FPythonPolicyToken> LexPythonPolicySource(const FString& Code)
    {
        TArray<FPythonPolicyToken> Tokens;
        Tokens.Reserve(FMath::Min(Code.Len() / 2, MaxPythonPolicyTokens));
        FPythonPolicyLexBudget Budget;
        LexPythonPolicySourceInto(Code, Tokens, Budget, 0);
        return Tokens;
    }

    bool TokenIsIdentifier(
        const TArray<FPythonPolicyToken>& Tokens,
        const int32 Index,
        const TCHAR* Expected = nullptr)
    {
        if (!Tokens.IsValidIndex(Index) || Tokens[Index].Kind != EPythonPolicyTokenKind::Identifier) return false;
        return Expected == nullptr || Tokens[Index].Text == Expected;
    }

    struct FPythonPolicyAliasBudget
    {
        int32 RemainingCopiedChars = MaxPythonPolicyAliasWorkChars;
        bool bExceeded = false;
    };

    bool ReadDottedPythonNameBounded(
        const TArray<FPythonPolicyToken>& Tokens,
        int32& Index,
        FString& OutName,
        FPythonPolicyAliasBudget* Budget)
    {
        if (!TokenIsIdentifier(Tokens, Index)) return false;

        // First measure the complete path without constructing it. Repeated
        // FString += on a componentized <=256 KiB name otherwise performs
        // quadratic prefix copying before any post-hoc path limit can run.
        const int32 Start = Index;
        int32 End = Index + 1;
        int32 ComponentCount = 1;
        int32 NameChars = Tokens[Index].Text.Len();
        if (NameChars > MaxPythonPolicyPathChars)
        {
            if (Budget) Budget->bExceeded = true;
            return false;
        }
        while (Tokens.IsValidIndex(End + 1)
            && Tokens[End].Kind == EPythonPolicyTokenKind::Dot
            && TokenIsIdentifier(Tokens, End + 1))
        {
            const int32 ComponentChars = Tokens[End + 1].Text.Len();
            if (ComponentCount >= MaxPythonPolicyPathComponents
                || ComponentChars > MaxPythonPolicyPathChars - NameChars - 1)
            {
                if (Budget) Budget->bExceeded = true;
                return false;
            }
            ++ComponentCount;
            NameChars += 1 + ComponentChars;
            if (Budget && NameChars > Budget->RemainingCopiedChars)
            {
                Budget->bExceeded = true;
                return false;
            }
            End += 2;
        }
        if (Budget && NameChars > Budget->RemainingCopiedChars)
        {
            Budget->bExceeded = true;
            return false;
        }

        // One exact reserve makes the construction linear. Charge that copy to
        // the same budget used by alias storage and resolution.
        if (Budget) Budget->RemainingCopiedChars -= NameChars;
        OutName.Reset();
        OutName.Reserve(NameChars);
        OutName += Tokens[Start].Text;
        for (int32 At = Start + 1; At < End; At += 2)
        {
            OutName.AppendChar(TEXT('.'));
            OutName += Tokens[At + 1].Text;
        }
        Index = End;
        return true;
    }

    FString FirstPythonNameComponent(const FString& Name)
    {
        int32 Dot = INDEX_NONE;
        return Name.FindChar(TEXT('.'), Dot) ? Name.Left(Dot) : Name;
    }

    bool AddBoundedPythonAlias(
        TMap<FString, FString>& Aliases,
        const FString& Local,
        const FString& Target,
        FPythonPolicyAliasBudget* Budget)
    {
        if (Target.Len() > MaxPythonPolicyPathChars
            || (Budget && Target.Len() > Budget->RemainingCopiedChars))
        {
            if (Budget) Budget->bExceeded = true;
            return false;
        }
        if (Budget) Budget->RemainingCopiedChars -= Target.Len();
        Aliases.Add(Local, Target);
        return true;
    }

    bool ApplyPythonImportAliasesAt(
        const TArray<FPythonPolicyToken>& Tokens,
        const int32 Cursor,
        TMap<FString, FString>& Aliases,
        int32& OutAfter,
        FPythonPolicyAliasBudget* Budget)
    {
        OutAfter = Cursor + 1;
        if (TokenIsIdentifier(Tokens, Cursor, TEXT("import")))
        {
            int32 At = Cursor + 1;
            while (At < Tokens.Num())
            {
                FString Imported;
                if (!ReadDottedPythonNameBounded(Tokens, At, Imported, Budget)) break;

                FString Local = FirstPythonNameComponent(Imported);
                if (TokenIsIdentifier(Tokens, At, TEXT("as")) && TokenIsIdentifier(Tokens, At + 1))
                {
                    Local = Tokens[At + 1].Text;
                    At += 2;
                }
                if (!AddBoundedPythonAlias(Aliases, Local, Imported, Budget)) return true;

                if (!Tokens.IsValidIndex(At) || Tokens[At].Kind != EPythonPolicyTokenKind::Comma) break;
                ++At;
            }
            OutAfter = At;
            return true;
        }

        if (!TokenIsIdentifier(Tokens, Cursor, TEXT("from"))) return false;
        int32 At = Cursor + 1;
        FString Module;
        if (!ReadDottedPythonNameBounded(Tokens, At, Module, Budget)
            || !TokenIsIdentifier(Tokens, At, TEXT("import")))
        {
            return false;
        }
        ++At;

        bool bParenthesized = false;
        if (Tokens.IsValidIndex(At) && Tokens[At].Kind == EPythonPolicyTokenKind::OpenParen)
        {
            bParenthesized = true;
            ++At;
        }
        while (At < Tokens.Num())
        {
            if (Tokens[At].Kind == EPythonPolicyTokenKind::CloseParen && bParenthesized)
            {
                ++At;
                break;
            }
            if (Tokens[At].Kind == EPythonPolicyTokenKind::Newline)
            {
                if (!bParenthesized) break;
                ++At;
                continue;
            }
            const bool bWildcard = Tokens.IsValidIndex(At)
                && Tokens[At].Kind == EPythonPolicyTokenKind::Other
                && Tokens[At].Text == TEXT("*");
            FString Imported;
            if (bWildcard)
            {
                Imported = TEXT("*");
                ++At;
            }
            else if (!ReadDottedPythonNameBounded(Tokens, At, Imported, Budget))
            {
                break;
            }
            FString Local = bWildcard ? TEXT("*") : FirstPythonNameComponent(Imported);
            if (!bWildcard
                && TokenIsIdentifier(Tokens, At, TEXT("as"))
                && TokenIsIdentifier(Tokens, At + 1))
            {
                Local = Tokens[At + 1].Text;
                At += 2;
            }
            const int32 TargetLen = Module.Len() + 1 + Imported.Len();
            if (TargetLen > MaxPythonPolicyPathChars
                || (Budget && TargetLen > Budget->RemainingCopiedChars))
            {
                if (Budget) Budget->bExceeded = true;
                return true;
            }
            if (Budget) Budget->RemainingCopiedChars -= TargetLen;
            FString Target = Module;
            Target.AppendChar(TEXT('.'));
            Target += Imported;
            if (!AddBoundedPythonAlias(Aliases, Local, Target, Budget)) return true;

            // Another imported identifier requires a comma. Treat malformed
            // continuation as unprovable instead of repeatedly rescanning an
            // overlapping token tail before Python eventually rejects it.
            while (bParenthesized
                && Tokens.IsValidIndex(At)
                && Tokens[At].Kind == EPythonPolicyTokenKind::Newline)
            {
                ++At;
            }
            if (Tokens.IsValidIndex(At) && Tokens[At].Kind == EPythonPolicyTokenKind::Comma)
            {
                ++At;
                continue;
            }
            if (bParenthesized
                && Tokens.IsValidIndex(At)
                && Tokens[At].Kind == EPythonPolicyTokenKind::CloseParen)
            {
                ++At;
                break;
            }
            if (!Tokens.IsValidIndex(At)
                || (!bParenthesized
                    && (Tokens[At].Kind == EPythonPolicyTokenKind::Newline
                        || Tokens[At].Kind == EPythonPolicyTokenKind::Semicolon)))
            {
                break;
            }
            if (Budget) Budget->bExceeded = true;
            return true;
        }
        OutAfter = At;
        return true;
    }

    bool ResolvePythonAliasPath(
        const FString& Path,
        const TMap<FString, FString>& Aliases,
        FPythonPolicyAliasBudget& Budget,
        FString& OutResolved)
    {
        if (Path.Len() > MaxPythonPolicyPathChars)
        {
            Budget.bExceeded = true;
            return false;
        }
        const FString First = FirstPythonNameComponent(Path);
        const FString* Target = Aliases.Find(First);
        if (!Target)
        {
            if (Path.Len() > Budget.RemainingCopiedChars)
            {
                Budget.bExceeded = true;
                return false;
            }
            Budget.RemainingCopiedChars -= Path.Len();
            OutResolved = Path;
            return true;
        }
        const int32 ResolvedLen = Target->Len() + Path.Len() - First.Len();
        if (ResolvedLen > MaxPythonPolicyPathChars
            || ResolvedLen > Budget.RemainingCopiedChars)
        {
            Budget.bExceeded = true;
            return false;
        }
        Budget.RemainingCopiedChars -= ResolvedLen;
        OutResolved = *Target;
        OutResolved += Path.Mid(First.Len());
        return true;
    }

    FString BuildAliasExpandedPythonCalls(const FString& Code)
    {
        const TArray<FPythonPolicyToken> Tokens = LexPythonPolicySource(Code);
        TMap<FString, FString> Aliases;
        FPythonPolicyAliasBudget AliasBudget;
        // These builtins do not need an import, so seed them explicitly. A
        // reference is treated like a call by the fatal policy: otherwise
        // `imp = __import__; imp('os')` or `pick = getattr; pick(...)` hides the
        // dangerous operation behind the first ordinary assignment.
        static const TArray<FString> DangerousBuiltinCallables = {
            TEXT("exec"), TEXT("eval"), TEXT("compile"), TEXT("__import__"),
            TEXT("getattr"), TEXT("setattr"), TEXT("delattr"),
            TEXT("globals"), TEXT("locals"), TEXT("vars"),
            TEXT("input"), TEXT("breakpoint"), TEXT("exit"), TEXT("quit"),
        };
        for (const FString& Callable : DangerousBuiltinCallables)
        {
            if (!AddBoundedPythonAlias(Aliases, Callable, Callable, &AliasBudget))
            {
                return TEXT("__hayba_alias_budget_limit__(");
            }
        }
        // Direct identity roots are not fatal by themselves, but their dotted
        // descriptors are: `pick = object.__getattribute__` must expand to the
        // same forbidden path as an imported-module attribute reference.
        static const TArray<FString> BuiltinIdentityRoots = {
            TEXT("object"), TEXT("type"),
        };
        for (const FString& Root : BuiltinIdentityRoots)
        {
            if (!AddBoundedPythonAlias(Aliases, Root, Root, &AliasBudget))
            {
                return TEXT("__hayba_alias_budget_limit__(");
            }
        }
        FString Expanded;

        auto AppendReference = [&Expanded](const FString& Resolved)
        {
            if (Expanded.Len() >= MaxPythonPolicyExpandedChars) return;
            TArray<FString> Components;
            Resolved.Left(MaxPythonPolicyPathChars).ParseIntoArray(Components, TEXT("."), true);
            FString Prefix;
            const int32 ComponentCount = FMath::Min(Components.Num(), MaxPythonPolicyPathComponents);
            for (int32 ComponentIndex = 0; ComponentIndex < ComponentCount; ++ComponentIndex)
            {
                if (!Prefix.IsEmpty()) Prefix += TEXT(".");
                Prefix += Components[ComponentIndex];
                if (Expanded.Len() + Prefix.Len() + 2 > MaxPythonPolicyExpandedChars) break;
                if (!Expanded.IsEmpty()) Expanded.AppendChar(TEXT(';'));
                Expanded += Prefix;
                Expanded.AppendChar(TEXT('('));
            }
        };

        for (int32 Cursor = 0; Cursor < Tokens.Num(); ++Cursor)
        {
            int32 AfterImport = Cursor + 1;
            if (ApplyPythonImportAliasesAt(Tokens, Cursor, Aliases, AfterImport, &AliasBudget))
            {
                if (AliasBudget.bExceeded) return TEXT("__hayba_alias_budget_limit__(");
                Cursor = AfterImport - 1;
                continue;
            }

            if (!TokenIsIdentifier(Tokens, Cursor)) continue;
            if (Cursor > 0 && Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Dot) continue;

            const bool bStatementStart = Cursor == 0
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Newline
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Semicolon
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Colon;

            if (bStatementStart
                && Tokens.IsValidIndex(Cursor + 2)
                && Tokens[Cursor + 1].Kind == EPythonPolicyTokenKind::Equal
                && Tokens[Cursor + 2].Kind != EPythonPolicyTokenKind::Equal)
            {
                const FString Local = Tokens[Cursor].Text;
                int32 AfterValue = Cursor + 2;
                int32 WrapperParens = 0;
                while (Tokens.IsValidIndex(AfterValue)
                    && Tokens[AfterValue].Kind == EPythonPolicyTokenKind::OpenParen)
                {
                    ++WrapperParens;
                    ++AfterValue;
                }
                FString AssignedPath;
                const bool bHasAssignedPath = ReadDottedPythonNameBounded(
                    Tokens,
                    AfterValue,
                    AssignedPath,
                    &AliasBudget);
                if (AliasBudget.bExceeded) return TEXT("__hayba_alias_budget_limit__(");
                while (bHasAssignedPath && WrapperParens > 0 && Tokens.IsValidIndex(AfterValue)
                    && Tokens[AfterValue].Kind == EPythonPolicyTokenKind::CloseParen)
                {
                    --WrapperParens;
                    ++AfterValue;
                }
                if (bHasAssignedPath && WrapperParens == 0
                    && (!Tokens.IsValidIndex(AfterValue)
                        || Tokens[AfterValue].Kind == EPythonPolicyTokenKind::Newline
                        || Tokens[AfterValue].Kind == EPythonPolicyTokenKind::Semicolon))
                {
                    const FString First = FirstPythonNameComponent(AssignedPath);
                    if (Aliases.Contains(First))
                    {
                        FString Resolved;
                        if (!ResolvePythonAliasPath(AssignedPath, Aliases, AliasBudget, Resolved)
                            || !AddBoundedPythonAlias(Aliases, Local, Resolved, &AliasBudget))
                        {
                            return TEXT("__hayba_alias_budget_limit__(");
                        }
                        AppendReference(Resolved);
                    }
                    else
                    {
                        // A plain reassignment to a non-alias invalidates the
                        // earlier binding, preventing broad false positives.
                        Aliases.Remove(Local);
                    }
                    Cursor = AfterValue - 1;
                    continue;
                }

                // Calls, literals, arithmetic, and other non-alias RHS forms
                // replace the local with an ordinary value. Clear the binding
                // now, but leave the RHS tokens to the normal fatal-reference
                // scan (for example `r = q.abort()` must still be rejected).
                // If the LHS shadows the same imported name used at the start
                // of the RHS (`Lock = Lock()`), resolve that first reference
                // before invalidating the old binding.
                if (bHasAssignedPath)
                {
                    const FString AssignedFirst = FirstPythonNameComponent(AssignedPath);
                    if (Aliases.Contains(AssignedFirst))
                    {
                        FString Resolved;
                        if (!ResolvePythonAliasPath(AssignedPath, Aliases, AliasBudget, Resolved))
                        {
                            return TEXT("__hayba_alias_budget_limit__(");
                        }
                        AppendReference(Resolved);
                    }
                }
                Aliases.Remove(Local);
                ++Cursor;
                continue;
            }

            int32 At = Cursor;
            FString Path;
            if (!ReadDottedPythonNameBounded(Tokens, At, Path, &AliasBudget))
            {
                if (AliasBudget.bExceeded) return TEXT("__hayba_alias_budget_limit__(");
                continue;
            }

            // Treat a reference to a fatal callable as fatal even when the
            // immediate syntax is not `name(...)`. Otherwise trivial Python
            // indirection such as `f = process.abort; f()` or
            // `process.abort.__call__()` evades source preflight. Appending an
            // opening parenthesis lets the existing exact callable rules judge
            // the canonical path without attempting unsafe data-flow analysis.
            FString Resolved;
            if (!ResolvePythonAliasPath(Path, Aliases, AliasBudget, Resolved))
            {
                return TEXT("__hayba_alias_budget_limit__(");
            }
            AppendReference(Resolved);
            Cursor = At - 1;
        }
        return Expanded;
    }

    bool FindReservedPythonRuntimeAccess(
        const FString& Code,
        const FString& AliasExpandedCalls,
        FString& OutPattern,
        FString& OutPolicyCode,
        FString& OutReason,
        FString& OutAlternative)
    {
        const TArray<FPythonPolicyToken> Tokens = LexPythonPolicySource(Code);
        FPythonPolicyAliasBudget ImportScanBudget;
        auto RefuseImportScanBudget = [
            &OutPattern,
            &OutPolicyCode,
            &OutReason,
            &OutAlternative]() -> bool
        {
            OutPattern = TEXT("alias_resolution_budget");
            OutPolicyCode = TEXT("HCR-DYNAMIC-001");
            OutReason = TEXT("exceeds bounded dotted-name/import alias work and cannot be proven safe");
            OutAlternative = TEXT("use short, comma-separated ordinary imports and direct calls");
            return true;
        };

        const FString CompactCode = CompactPythonSource(Code);
        if (CompactCode.Contains(TEXT(".f_locals['_hb_deadline']")))
        {
            OutPattern = TEXT("f_locals['_hb_deadline']");
            OutPolicyCode = TEXT("HCR-TIME-001");
            OutReason = TEXT("attempts to mutate reserved cooperative-deadline state through a private frame");
            OutAlternative = TEXT("use application-owned variable names and leave private wrapper frames inaccessible");
            return true;
        }

        // Specific deadline-state access outranks the broader module used to
        // reach it. Diagnose the attempted effect, not merely `import inspect`.
        for (const FPythonPolicyToken& Token : Tokens)
        {
            if (Token.Kind != EPythonPolicyTokenKind::Identifier
                || !Token.Text.StartsWith(TEXT("_hb_")))
            {
                continue;
            }
            if (Token.Text.Contains(TEXT("deadline"))
                || Token.Text.Contains(TEXT("trace"))
                || Token.Text == TEXT("_hb_sys")
                || Token.Text == TEXT("_hb_time"))
            {
                OutPattern = Token.Text;
                OutPolicyCode = TEXT("HCR-TIME-001");
                OutReason = TEXT("attempts to access reserved cooperative-deadline state");
                OutAlternative = TEXT("use application-owned variable names and leave the deadline hook private");
                return true;
            }
        }

        // This bounded, incident-driven stdlib list is not a claim that source
        // preflight can make arbitrary in-process Python complete or safe.
        // These modules can recover hidden attributes, load code, or
        // deserialize attacker-shaped objects without spelling the eventual
        // crash primitive in source. Until #392 provides a killable Python
        // process, refuse their executable imports at the authoritative native
        // boundary. ApplyPythonImportAliasesAt resolves both aliases and
        // submodules (`import importlib.util as u`, `from inspect import ...`).
        static const TSet<FString> HighRiskDynamicPythonModules = {
            TEXT("inspect"), TEXT("pydoc"), TEXT("pickle"), TEXT("marshal"),
            TEXT("types"), TEXT("pkgutil"), TEXT("runpy"), TEXT("importlib"),
            TEXT("traceback"),
        };
        // These are process-global module singletons used by the trusted
        // wrapper before tracing starts or while it restores/collects state.
        // Letting one request import and monkey-patch them poisons later
        // requests even though each request gets a fresh globals dictionary.
        // Refuse every executable import form, including from/as aliases.
        static const TSet<FString> TrustedWrapperPythonModules = {
            TEXT("time"), TEXT("base64"), TEXT("sys"), TEXT("gc"),
        };
        for (int32 Cursor = 0; Cursor < Tokens.Num(); ++Cursor)
        {
            if (!TokenIsIdentifier(Tokens, Cursor, TEXT("import"))
                && !TokenIsIdentifier(Tokens, Cursor, TEXT("from")))
            {
                continue;
            }
            TMap<FString, FString> ImportedBindings;
            int32 AfterImport = Cursor + 1;
            const bool bAppliedImport = ApplyPythonImportAliasesAt(
                Tokens,
                Cursor,
                ImportedBindings,
                AfterImport,
                &ImportScanBudget);
            if (ImportScanBudget.bExceeded)
            {
                return RefuseImportScanBudget();
            }
            if (!bAppliedImport)
            {
                continue;
            }
            for (const TPair<FString, FString>& Binding : ImportedBindings)
            {
                if (Binding.Key == TEXT("*") || Binding.Value.EndsWith(TEXT(".*")))
                {
                    OutPattern = TEXT("wildcard import");
                    OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                    OutReason = TEXT("imports policy-denied callables without names that source alias analysis can prove");
                    OutAlternative = TEXT("import only the specific policy-visible names required by the request");
                    return true;
                }
                const FString ModuleRoot = FirstPythonNameComponent(Binding.Value);
                if (TrustedWrapperPythonModules.Contains(ModuleRoot))
                {
                    OutPattern = FString::Printf(TEXT("import %s"), *ModuleRoot);
                    OutPolicyCode = ModuleRoot == TEXT("time") || ModuleRoot == TEXT("sys")
                        ? TEXT("HCR-TIME-001")
                        : TEXT("HCR-DYNAMIC-001");
                    OutReason = TEXT("can mutate a process-global module used by trusted wrapper setup, deadline enforcement, readback, or cleanup and poison later requests");
                    OutAlternative = TEXT("use policy-visible request-local values or a typed handler; trusted wrapper modules are not exposed to user scripts");
                    return true;
                }
                if (!HighRiskDynamicPythonModules.Contains(ModuleRoot)) continue;
                OutPattern = FString::Printf(TEXT("import %s"), *ModuleRoot);
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("exposes dynamic lookup, code loading, or deserialization that can reconstruct a hidden editor-crash primitive");
                OutAlternative = TEXT("use a validated typed handler for the intended operation; broader Python requires the process isolation tracked in #392");
                return true;
            }
            Cursor = FMath::Max(Cursor, AfterImport - 1);
        }

        // Known CPython object-graph/importer discovery spellings can recover
        // modules without an ordinary import (for example by walking
        // object.__subclasses__ to BuiltinImporter.load_module). This is a
        // bounded incident-driven refusal, not a claim that source policy makes
        // arbitrary in-process Python safe: process isolation remains #392.
        static const TSet<FString> ObjectGraphImporterDiscoveryTokens = {
            TEXT("__subclasses__"), TEXT("__base__"), TEXT("__bases__"),
            TEXT("__mro__"), TEXT("__loader__"), TEXT("__spec__"),
            TEXT("builtinimporter"), TEXT("frozenimporter"),
            TEXT("load_module"), TEXT("find_spec"), TEXT("module_from_spec"),
            TEXT("create_module"), TEXT("exec_module"),
        };
        for (const FPythonPolicyToken& Token : Tokens)
        {
            if (Token.Kind != EPythonPolicyTokenKind::Identifier
                || !ObjectGraphImporterDiscoveryTokens.Contains(Token.Text))
            {
                continue;
            }
            OutPattern = Token.Text;
            OutPolicyCode = TEXT("HCR-DYNAMIC-001");
            OutReason = TEXT("can discover a hidden importer or traverse the CPython object graph to load policy-invisible process modules");
            OutAlternative = TEXT("use ordinary policy-visible imports and direct APIs; broader Python requires the process isolation tracked in #392");
            return true;
        }

        // The bytecode deadline is cooperative. When its trace callback raises,
        // CPython disables tracing before propagating the exception. A user
        // try/except can swallow it, while finally and context-manager __exit__
        // code can then run forever without another deadline event. Until #392
        // moves arbitrary Python into a killable process, refuse all executable
        // exception/context cleanup syntax. Strings and comments never produce
        // these lexical identifiers and remain benign.
        for (const FPythonPolicyToken& Token : Tokens)
        {
            if (Token.Kind != EPythonPolicyTokenKind::Identifier) continue;
            if (Token.Text == TEXT("try") || Token.Text == TEXT("with"))
            {
                OutPattern = Token.Text == TEXT("try")
                    ? TEXT("try statement")
                    : TEXT("with statement");
                OutPolicyCode = TEXT("HCR-TIME-001");
                OutReason = TEXT("can continue in except/finally/__exit__ after CPython disables the cooperative trace hook");
                OutAlternative = TEXT("return explicit status values, use straight-line bounded cleanup, or move the operation to an owned typed handler; process-isolated Python is tracked in #392");
                return true;
            }
        }

        // A Python trace exception is cooperative: user code can catch it. In
        // CPython, an exception raised by a trace callback also disables that
        // callback, so a catch-all handler could swallow the deadline and then
        // wedge the editor forever. Prove handler types are Exception-derived
        // using only this already-bounded token stream. Unknown/dynamic handler
        // expressions fail closed; source preflight cannot safely evaluate
        // Exception.__base__, subscripts, calls, or imported class hierarchies.
        TSet<FString> SafeExceptionNames = {
            TEXT("exception"), TEXT("exceptiongroup"),
            TEXT("arithmeticerror"), TEXT("assertionerror"), TEXT("attributeerror"),
            TEXT("buffererror"), TEXT("eoferror"), TEXT("importerror"),
            TEXT("lookuperror"), TEXT("memoryerror"), TEXT("nameerror"),
            TEXT("oserror"), TEXT("environmenterror"), TEXT("ioerror"),
            TEXT("windowserror"), TEXT("referenceerror"), TEXT("runtimeerror"),
            TEXT("stopasynciteration"), TEXT("stopiteration"), TEXT("syntaxerror"),
            TEXT("indentationerror"), TEXT("taberror"),
            TEXT("systemerror"), TEXT("typeerror"), TEXT("valueerror"), TEXT("warning"),
            TEXT("floatingpointerror"), TEXT("overflowerror"), TEXT("zerodivisionerror"),
            TEXT("modulenotfounderror"), TEXT("indexerror"), TEXT("keyerror"),
            TEXT("unboundlocalerror"), TEXT("blockingioerror"), TEXT("childprocesserror"),
            TEXT("connectionerror"), TEXT("fileexistserror"), TEXT("filenotfounderror"),
            TEXT("interruptederror"), TEXT("isadirectoryerror"), TEXT("notadirectoryerror"),
            TEXT("permissionerror"), TEXT("processlookuperror"), TEXT("timeouterror"),
            TEXT("brokenpipeerror"), TEXT("connectionabortederror"),
            TEXT("connectionrefusederror"), TEXT("connectionreseterror"),
            TEXT("unicodeerror"), TEXT("unicodedecodeerror"), TEXT("unicodeencodeerror"),
            TEXT("unicodetranslateerror"), TEXT("byteswarning"),
            TEXT("deprecationwarning"), TEXT("encodingwarning"), TEXT("futurewarning"),
            TEXT("importwarning"), TEXT("pendingdeprecationwarning"),
            TEXT("resourcewarning"), TEXT("runtimewarning"), TEXT("syntaxwarning"),
            TEXT("unicodewarning"), TEXT("userwarning"), TEXT("recursionerror"),
            TEXT("notimplementederror"),
        };

        auto IsProvenSafeExceptionExpression = [&Tokens, &SafeExceptionNames](
            const int32 Start,
            const int32 End) -> bool
        {
            if (Start >= End) return false;
            TArray<bool> GroupHasValue;
            GroupHasValue.Reserve(FMath::Min(End - Start, MaxPythonPolicyPathComponents));
            bool bExpectValue = true;
            bool bTopHasValue = false;
            for (int32 At = Start; At < End; ++At)
            {
                const FPythonPolicyToken& Token = Tokens[At];
                if (Token.Kind == EPythonPolicyTokenKind::OpenParen)
                {
                    if (!bExpectValue || GroupHasValue.Num() >= MaxPythonPolicyPathComponents) return false;
                    GroupHasValue.Add(false);
                    continue;
                }
                if (Token.Kind == EPythonPolicyTokenKind::Identifier)
                {
                    if (!bExpectValue || !SafeExceptionNames.Contains(Token.Text)) return false;
                    bExpectValue = false;
                    if (GroupHasValue.Num() > 0) GroupHasValue.Last() = true;
                    else bTopHasValue = true;
                    continue;
                }
                if (Token.Kind == EPythonPolicyTokenKind::Comma)
                {
                    if (bExpectValue || GroupHasValue.Num() == 0) return false;
                    bExpectValue = true;
                    continue;
                }
                if (Token.Kind == EPythonPolicyTokenKind::CloseParen)
                {
                    if (GroupHasValue.Num() == 0 || !GroupHasValue.Last()) return false;
                    GroupHasValue.Pop(EAllowShrinking::No);
                    bExpectValue = false;
                    if (GroupHasValue.Num() > 0) GroupHasValue.Last() = true;
                    else bTopHasValue = true;
                    continue;
                }
                // Dot, subscript, call, binary expression, or any other syntax
                // is not a statically proven Exception-derived handler type.
                return false;
            }
            return GroupHasValue.Num() == 0 && !bExpectValue && bTopHasValue;
        };

        TSet<FString> PermanentlyUnprovenExceptionNames;
        auto MarkExceptionNameUnproven = [
            &SafeExceptionNames,
            &PermanentlyUnprovenExceptionNames](const FString& Name)
        {
            SafeExceptionNames.Remove(Name);
            PermanentlyUnprovenExceptionNames.Add(Name);
        };
        for (int32 Cursor = 0; Cursor < Tokens.Num(); ++Cursor)
        {
            const bool bStatementStart = Cursor == 0
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Newline
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Semicolon
                || Tokens[Cursor - 1].Kind == EPythonPolicyTokenKind::Colon;

            // Bindings other than a proven class/alias can shadow a safe name.
            // Record them for the whole source because a function body may be
            // defined before, but execute after, a later global reassignment.
            if (TokenIsIdentifier(Tokens, Cursor, TEXT("as"))
                && TokenIsIdentifier(Tokens, Cursor + 1))
            {
                MarkExceptionNameUnproven(Tokens[Cursor + 1].Text);
            }
            if (bStatementStart
                && TokenIsIdentifier(Tokens, Cursor, TEXT("for")))
            {
                for (int32 At = Cursor + 1; Tokens.IsValidIndex(At); ++At)
                {
                    if (TokenIsIdentifier(Tokens, At, TEXT("in"))
                        || Tokens[At].Kind == EPythonPolicyTokenKind::Newline
                        || Tokens[At].Kind == EPythonPolicyTokenKind::Semicolon)
                    {
                        break;
                    }
                    if (Tokens[At].Kind == EPythonPolicyTokenKind::Identifier)
                    {
                        MarkExceptionNameUnproven(Tokens[At].Text);
                    }
                }
            }
            if (bStatementStart
                && TokenIsIdentifier(Tokens, Cursor, TEXT("def"))
                && TokenIsIdentifier(Tokens, Cursor + 1))
            {
                MarkExceptionNameUnproven(Tokens[Cursor + 1].Text);
                int32 At = Cursor + 2;
                while (Tokens.IsValidIndex(At)
                    && Tokens[At].Kind != EPythonPolicyTokenKind::OpenParen
                    && Tokens[At].Kind != EPythonPolicyTokenKind::Newline) ++At;
                if (Tokens.IsValidIndex(At)
                    && Tokens[At].Kind == EPythonPolicyTokenKind::OpenParen)
                {
                    int32 Depth = 1;
                    bool bExpectParameterName = true;
                    for (++At; Tokens.IsValidIndex(At) && Depth > 0; ++At)
                    {
                        if (Tokens[At].Kind == EPythonPolicyTokenKind::OpenParen)
                        {
                            ++Depth;
                            continue;
                        }
                        if (Tokens[At].Kind == EPythonPolicyTokenKind::CloseParen)
                        {
                            --Depth;
                            continue;
                        }
                        if (Depth != 1) continue;
                        if (Tokens[At].Kind == EPythonPolicyTokenKind::Comma)
                        {
                            bExpectParameterName = true;
                            continue;
                        }
                        if (bExpectParameterName
                            && Tokens[At].Kind == EPythonPolicyTokenKind::Identifier)
                        {
                            MarkExceptionNameUnproven(Tokens[At].Text);
                            bExpectParameterName = false;
                        }
                    }
                }
            }
            if (bStatementStart
                && (TokenIsIdentifier(Tokens, Cursor, TEXT("import"))
                    || TokenIsIdentifier(Tokens, Cursor, TEXT("from"))))
            {
                TMap<FString, FString> ImportedBindings;
                int32 AfterImport = Cursor + 1;
                const bool bAppliedImport = ApplyPythonImportAliasesAt(
                    Tokens,
                    Cursor,
                    ImportedBindings,
                    AfterImport,
                    &ImportScanBudget);
                if (ImportScanBudget.bExceeded)
                {
                    return RefuseImportScanBudget();
                }
                if (bAppliedImport)
                {
                    for (const TPair<FString, FString>& Binding : ImportedBindings)
                    {
                        MarkExceptionNameUnproven(Binding.Key);
                    }
                    Cursor = FMath::Max(Cursor, AfterImport - 1);
                }
            }

            // A simple local class whose every base is already proven safe can
            // be caught without weakening the deadline. Imported/dynamic bases
            // remain unknown and are refused at the handler.
            if (bStatementStart
                && TokenIsIdentifier(Tokens, Cursor, TEXT("class"))
                && TokenIsIdentifier(Tokens, Cursor + 1))
            {
                const FString ClassName = Tokens[Cursor + 1].Text;
                int32 ColonAt = Cursor + 2;
                while (Tokens.IsValidIndex(ColonAt)
                    && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Colon
                    && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Newline
                    && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Semicolon)
                {
                    ++ColonAt;
                }
                if (!PermanentlyUnprovenExceptionNames.Contains(ClassName)
                    && Tokens.IsValidIndex(Cursor + 2)
                    && Tokens[Cursor + 2].Kind == EPythonPolicyTokenKind::OpenParen
                    && IsProvenSafeExceptionExpression(Cursor + 2, ColonAt))
                {
                    SafeExceptionNames.Add(ClassName);
                }
                else
                {
                    SafeExceptionNames.Remove(ClassName);
                    PermanentlyUnprovenExceptionNames.Add(ClassName);
                }
            }

            // Preserve straightforward aliases and tuples of proven-safe
            // exception types. Reassignment to anything dynamic invalidates the
            // earlier proof before a later handler can use it.
            if (bStatementStart
                && TokenIsIdentifier(Tokens, Cursor))
            {
                const FString Local = Tokens[Cursor].Text;
                int32 EqualAt = Cursor + 1;
                while (Tokens.IsValidIndex(EqualAt)
                    && Tokens[EqualAt].Kind != EPythonPolicyTokenKind::Newline
                    && Tokens[EqualAt].Kind != EPythonPolicyTokenKind::Semicolon)
                {
                    const bool bSingleEqual = Tokens[EqualAt].Kind == EPythonPolicyTokenKind::Equal
                        && (!Tokens.IsValidIndex(EqualAt - 1)
                            || Tokens[EqualAt - 1].Kind != EPythonPolicyTokenKind::Equal)
                        && (!Tokens.IsValidIndex(EqualAt + 1)
                            || Tokens[EqualAt + 1].Kind != EPythonPolicyTokenKind::Equal);
                    if (bSingleEqual) break;
                    ++EqualAt;
                }
                if (!Tokens.IsValidIndex(EqualAt)
                    || Tokens[EqualAt].Kind != EPythonPolicyTokenKind::Equal)
                {
                    continue;
                }
                int32 AfterValue = EqualAt + 1;
                while (Tokens.IsValidIndex(AfterValue)
                    && Tokens[AfterValue].Kind != EPythonPolicyTokenKind::Newline
                    && Tokens[AfterValue].Kind != EPythonPolicyTokenKind::Semicolon)
                {
                    ++AfterValue;
                }
                if (!PermanentlyUnprovenExceptionNames.Contains(Local)
                    && IsProvenSafeExceptionExpression(EqualAt + 1, AfterValue))
                {
                    SafeExceptionNames.Add(Local);
                }
                else
                {
                    SafeExceptionNames.Remove(Local);
                    PermanentlyUnprovenExceptionNames.Add(Local);
                }
            }

            // Declaration pass only. It intentionally consumes the complete
            // source before judging any handler: a later reassignment can
            // change the global captured by an earlier function body.
        }

        for (int32 Cursor = 0; Cursor < Tokens.Num(); ++Cursor)
        {
            if (!TokenIsIdentifier(Tokens, Cursor, TEXT("except"))) continue;
            int32 HandlerStart = Cursor + 1;
            if (Tokens.IsValidIndex(HandlerStart)
                && Tokens[HandlerStart].Kind == EPythonPolicyTokenKind::Other
                && Tokens[HandlerStart].Text == TEXT("*"))
            {
                ++HandlerStart;
            }
            if (Tokens.IsValidIndex(HandlerStart)
                && Tokens[HandlerStart].Kind == EPythonPolicyTokenKind::Colon)
            {
                OutPattern = TEXT("bare except");
                OutPolicyCode = TEXT("HCR-TIME-001");
                OutReason = TEXT("can swallow the cooperative deadline exception after CPython disables its trace hook");
                OutAlternative = TEXT("catch Exception or the specific recoverable exception types the script expects");
                return true;
            }

            int32 ColonAt = HandlerStart;
            while (Tokens.IsValidIndex(ColonAt)
                && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Colon
                && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Newline
                && Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Semicolon)
            {
                ++ColonAt;
            }
            int32 ExpressionEnd = ColonAt;
            int32 Depth = 0;
            for (int32 At = HandlerStart; At < ColonAt; ++At)
            {
                if (Tokens[At].Kind == EPythonPolicyTokenKind::OpenParen) ++Depth;
                else if (Tokens[At].Kind == EPythonPolicyTokenKind::CloseParen) --Depth;
                else if (Depth == 0 && TokenIsIdentifier(Tokens, At, TEXT("as")))
                {
                    ExpressionEnd = At;
                    if (!TokenIsIdentifier(Tokens, At + 1) || At + 2 != ColonAt)
                    {
                        ExpressionEnd = HandlerStart;
                    }
                    break;
                }
            }
            if (!Tokens.IsValidIndex(ColonAt)
                || Tokens[ColonAt].Kind != EPythonPolicyTokenKind::Colon
                || !IsProvenSafeExceptionExpression(HandlerStart, ExpressionEnd))
            {
                OutPattern = TEXT("unproven exception handler");
                OutPolicyCode = TEXT("HCR-TIME-001");
                OutReason = TEXT("is not statically proven Exception-derived and could swallow the private cooperative deadline after CPython disables its trace hook");
                OutAlternative = TEXT("catch Exception, a direct built-in Exception subclass, a proven local subclass, or a tuple of those types");
                return true;
            }
        }

        for (const FPythonPolicyToken& Token : Tokens)
        {
            if (Token.Kind != EPythonPolicyTokenKind::Identifier) continue;
            if (Token.Text.StartsWith(TEXT("_hb_")))
            {
                OutPattern = Token.Text;
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("attempts to access a reserved wrapper-internal name");
                OutAlternative = TEXT("rename the application variable without the reserved _hb_ prefix");
                return true;
            }
            if (Token.Text == TEXT("__main__"))
            {
                OutPattern = Token.Text;
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("can expose the private wrapper module and its execution controls");
                OutAlternative = TEXT("keep request state in the isolated script namespace instead of importing __main__");
                return true;
            }
            if (Token.Text == TEXT("builtins"))
            {
                if (AliasExpandedCalls.Contains(TEXT("builtins.input(")))
                {
                    OutPattern = TEXT("builtins.input(");
                    OutPolicyCode = TEXT("HCR-BLOCK-001");
                    OutReason = TEXT("waits for stdin that an unattended editor cannot provide");
                    OutAlternative = TEXT("request input through the MCP user-prompt tool before python_run");
                    return true;
                }
                OutPattern = Token.Text;
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("can mutate process-global Python helpers used after the request");
                OutAlternative = TEXT("use ordinary built-in names without importing or modifying the builtins module");
                return true;
            }
            if (Token.Text == TEXT("__builtins__"))
            {
                OutPattern = Token.Text;
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("can index the copied built-in namespace to hide imports, dynamic execution, or deadline tampering from source policy");
                OutAlternative = TEXT("use policy-visible imports and built-in calls directly by name");
                return true;
            }
        }

        TArray<FString> ExpandedReferences;
        AliasExpandedCalls.ParseIntoArray(ExpandedReferences, TEXT(";"), true);
        for (const FString& Reference : ExpandedReferences)
        {
            static const TArray<FString> FatalCallableSuffixes = {
                TEXT(".abort("), TEXT(".kill("), TEXT("._exit("), TEXT(".settrace("),
            };
            for (const FString& Suffix : FatalCallableSuffixes)
            {
                if (!Reference.EndsWith(Suffix)) continue;
                OutPattern = Suffix.LeftChop(1);
                OutPolicyCode = Suffix == TEXT(".settrace(")
                    ? TEXT("HCR-TIME-001")
                    : TEXT("HCR-EXIT-001");
                OutReason = Suffix == TEXT(".settrace(")
                    ? TEXT("can disable or replace the cooperative execution deadline through an unresolved alias")
                    : TEXT("is a fatal process-control callable suffix that cannot be safely resolved in-process");
                OutAlternative = Suffix == TEXT(".settrace(")
                    ? TEXT("leave the deadline hook intact and split long work into bounded requests")
                    : TEXT("return normally and use the typed editor shutdown workflow where appropriate");
                return true;
            }

            if (Reference.EndsWith(TEXT(".settrace("))
                || Reference.EndsWith(TEXT(".setprofile(")))
            {
                OutPattern = Reference.EndsWith(TEXT(".settrace("))
                    ? TEXT(".settrace")
                    : TEXT(".setprofile");
                OutPolicyCode = TEXT("HCR-TIME-001");
                OutReason = TEXT("disables, replaces, or monkey-patches execution instrumentation used by the cooperative deadline");
                OutAlternative = TEXT("leave runtime instrumentation intact and split long work into bounded requests");
                return true;
            }

            static const TArray<FString> PrivateIntrospectionSuffixes = {
                TEXT(".modules("),
                TEXT("._getframe("),
                TEXT(".currentframe("),
                TEXT(".f_back("),
                TEXT(".f_globals("),
                TEXT(".f_locals("),
                TEXT(".f_trace("),
                TEXT(".__globals__("),
                TEXT(".__closure__("),
            };
            for (const FString& Suffix : PrivateIntrospectionSuffixes)
            {
                if (!Reference.EndsWith(Suffix)) continue;
                OutPattern = Suffix.LeftChop(1);
                OutPolicyCode = TEXT("HCR-DYNAMIC-001");
                OutReason = TEXT("can traverse into private wrapper frames or module state and tamper with execution controls");
                OutAlternative = TEXT("use values in the isolated request namespace and direct, policy-visible APIs");
                return true;
            }
        }

        return false;
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
        // Keep structural matching for legacy non-call rules, but augment it
        // with lexically parsed, alias-expanded call paths. `import os as q;
        // q.kill(...)` therefore presents the exact canonical `os.kill(` path
        // to the same rule table instead of relying on an alias substring.
        const FString Compact = CompactPythonSource(Code);
        const FString AliasExpandedCalls = BuildAliasExpandedPythonCalls(Code);

        if (FindReservedPythonRuntimeAccess(
            Code,
            AliasExpandedCalls,
            OutPattern,
            OutPolicyCode,
            OutReason,
            OutAlternative))
        {
            return true;
        }

        // os.abort is deliberately lexical-only. Adding it to the compact
        // substring table would reject a comment or string that merely explains
        // the forbidden API.
        TArray<FString> ExactExpandedCalls;
        AliasExpandedCalls.ParseIntoArray(ExactExpandedCalls, TEXT(";"), true);
        if (ExactExpandedCalls.Contains(TEXT("__hayba_fstring_nesting_limit__(")))
        {
            OutPattern = TEXT("f_string_nesting_limit");
            OutPolicyCode = TEXT("HCR-DYNAMIC-001");
            OutReason = TEXT("exceeds the bounded f-string policy inspection depth and cannot be proven safe");
            OutAlternative = TEXT("flatten the expression into named intermediate values and call inspected APIs directly");
            return true;
        }
        if (ExactExpandedCalls.Contains(TEXT("__hayba_alias_budget_limit__(")))
        {
            OutPattern = TEXT("alias_resolution_budget");
            OutPolicyCode = TEXT("HCR-DYNAMIC-001");
            OutReason = TEXT("exceeds the bounded alias path/copy-work budget and cannot be proven safe");
            OutAlternative = TEXT("use short direct imports and calls without recursively growing alias paths");
            return true;
        }
        if (ExactExpandedCalls.Contains(TEXT("os.abort(")))
        {
            OutPattern = TEXT("os.abort(");
            OutPolicyCode = TEXT("HCR-EXIT-001");
            OutReason = TEXT("terminates the editor process immediately through the C runtime");
            OutAlternative = TEXT("return from python_run and use the typed editor shutdown workflow");
            return true;
        }

        for (const FFatalPythonRule& Rule : FatalPythonRules())
        {
            // Deadline-tampering rules are lexical-only. The compact stream
            // intentionally retains strings for property-name policies, so
            // using it here would reject print("sys.settrace(None)") even
            // though no instrumentation access is executable.
            const bool bDeadlineRule = FCString::Strcmp(Rule.PolicyCode, TEXT("HCR-TIME-001")) == 0;
            const bool bLexicalOnlyDynamicImport = FCString::Strcmp(Rule.Pattern, TEXT("importlib.")) == 0;
            if ((!bDeadlineRule && !bLexicalOnlyDynamicImport
                    && CompactContainsPolicyPattern(Compact, Rule.Pattern))
                || CompactContainsPolicyPattern(AliasExpandedCalls, Rule.Pattern))
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

    bool ShouldBlockTier3(const EPythonTier Tier)
    {
        return Tier == EPythonTier::Unsafe;
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
static bool ExecPythonGuardedRaw(IPythonScriptPlugin* Plugin, FPythonCommandEx* Cmd, bool& bOutCrashed)
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

// A caught fault does not unwind the frames it jumped over, so the engine's own
// play-world switch (UEditorEngine::OnScriptExecutionStart, which fires whenever
// python reaches Blueprint code on a PIE object) can be left pushed — and GWorld
// stuck on the PIE world kills the editor on the next tick. See the long note in
// HaybaMCPSeh.h. Same repair as HaybaSeh::RunGuarded, applied to this handler's
// own guard; the __try stays isolated in ExecPythonGuardedRaw for C2712.
static bool ExecPythonGuarded(IPythonScriptPlugin* Plugin, FPythonCommandEx* Cmd, bool& bOutCrashed)
{
    const HaybaSeh::FWorldSwitchSnapshot Before = HaybaSeh::CaptureWorldSwitchState();
    const bool bResult = ExecPythonGuardedRaw(Plugin, Cmd, bOutCrashed);
    if (bOutCrashed)
    {
        HaybaSeh::RepairWorldSwitchState(Before);
    }
    return bResult;
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
    // Keep both booleans in this pure test seam to prove legacy callers and
    // persisted settings cannot change the production predicate.
    (void)bSettingAllows;
    (void)bAllowUnsafeOverride;
    return ShouldBlockTier3(ClassifyScript(Script));
}
#endif

EPythonTier FHaybaMCPPythonHandler::ClassifyScript(const FString& Code)
{
    static const TArray<FString> Tier3Keywords = {
        TEXT("subprocess"), TEXT("os.system"), TEXT("os.popen"),
        TEXT("os.remove("), TEXT("os.unlink("), TEXT("os.rename("),
        TEXT("os.renames("), TEXT("os.replace("), TEXT("os.mkdir("),
        TEXT("os.makedirs("), TEXT("os.rmdir("), TEXT("os.removedirs("),
        TEXT("os.truncate("), TEXT("os.chmod("), TEXT("os.chown("),
        TEXT("os.lchown("), TEXT("os.link("), TEXT("os.symlink("),
        TEXT("os.mknod("),
        TEXT(".write_text("), TEXT(".write_bytes("), TEXT(".unlink("),
        TEXT(".rename("), TEXT(".replace("), TEXT(".mkdir("),
        TEXT(".rmdir("), TEXT(".touch("), TEXT(".chmod("),
        TEXT(".lchmod("), TEXT(".symlink_to("), TEXT(".hardlink_to("),
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
    FString PolicyVisible = CompactPythonSource(Code);
    PolicyVisible.AppendChar(TEXT(';'));
    PolicyVisible += BuildAliasExpandedPythonCalls(Code);

    for (const FString& K : Tier3Keywords)
    {
        if (PolicyVisible.Contains(CompactPythonSource(K))) return EPythonTier::Unsafe;
    }
    for (const FString& K : Tier2Keywords)
    {
        if (PolicyVisible.Contains(CompactPythonSource(K))) return EPythonTier::Mutation;
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
    if (P->HasField(TEXT("allow_unsafe"))
        && !P->HasTypedField<EJson::Boolean>(TEXT("allow_unsafe")))
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run invalid_request [HCR-INPUT-001]: matched 'allow_unsafe_type'; field 'allow_unsafe' must be a boolean when present. "
            "Facts: policy_phase:pre_execute, allow_unsafe_effective:false, allow_unsafe_deprecated:true. "
            "Safe alternative: omit the deprecated compatibility field. Retry unchanged: forbidden."));
    }
    if (Code.Len() > MaxPythonScriptChars)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [HCR-SIZE-001]: matched 'script_size'; script is %d characters and the limit is %d. Safe alternative: split the work into bounded requests. Retry unchanged: forbidden."),
            Code.Len(), MaxPythonScriptChars));
    }

    bool bAllowUnsafeRequested = false;
    P->TryGetBoolField(TEXT("allow_unsafe"), bAllowUnsafeRequested);

    FString FatalPattern;
    FString FatalPolicyCode;
    FString FatalReason;
    FString FatalAlternative;
    if (FindFatalPythonPattern(Code, FatalPattern, FatalPolicyCode, FatalReason, FatalAlternative))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [%s]: matched '%s', which %s. Safe alternative: %s. Retry unchanged: forbidden. allow_unsafe is deprecated and ineffective; it never overrides an embedded-Python policy."),
            *FatalPolicyCode, *FatalPattern, *FatalReason, *FatalAlternative));
    }

    // Classify
    EPythonTier Tier = ClassifyScript(Code);

    // Tier 3 is an unconditional pre-execute refusal. Read the legacy field
    // only to report compatibility facts; neither it nor any persisted setting
    // is consulted as authority. Keep this branch before PythonScriptPlugin
    // access so direct TCP callers get exactly the same boundary as the TS
    // wrapper.
    if (ShouldBlockTier3(Tier))
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT(
            "python_run policy_blocked [HCR-SANDBOX-001]: matched 'tier_3_filesystem_or_subprocess'. "
            "Tier-3 host filesystem, subprocess, and network access is unavailable from embedded python_run. "
            "Facts: tier:3, policy_phase:pre_execute, allow_unsafe_requested:%s, allow_unsafe_effective:false, allow_unsafe_deprecated:true. "
            "Safe alternative: use a typed brokered MCP tool (#412/#415). Retry unchanged: forbidden. "
            "This classification boundary does not claim arbitrary in-process Python safety; isolation remains tracked by #392/#414."),
            bAllowUnsafeRequested ? TEXT("true") : TEXT("false")));
    }

    // Check Python plugin
    IPythonScriptPlugin* PythonPlugin = IPythonScriptPlugin::Get();
    if (!PythonPlugin)
    {
        return FHaybaHandlerResult::Err(TEXT("Python plugin not loaded — enable the PythonScriptPlugin in your project"));
    }

    // Capture stdout/stderr. ExecuteStatement mode sends print() to the editor's
    // Python log, NOT to CommandResult (which only carries a last-expression repr
    // in Evaluate mode). A StringIO here is a process-memory vulnerability: one
    // bounded request can print the same large value indefinitely until the
    // cooperative deadline, and traceback.format_exc() creates another complete
    // copy. The internal sink below never retains more than the fixed per-stream
    // limit, never joins an unbounded argument list, and formats tracebacks a
    // frame at a time. The response says exactly when and how much was dropped.
    // This bounds capture-owned amplification; it cannot undo memory the user
    // explicitly allocates before write(), such as `'x' * 2_000_000_000`.
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
    Wrapper += TEXT("import builtins as _hb_b, base64 as _hb_64, gc as _hb_gc, sys as _hb_sys, time as _hb_time\n");
    Wrapper += FString::Printf(TEXT("_hb_src = _hb_64.b64decode('%s').decode('utf-8')\n"), *CodeB64);
    Wrapper += TEXT("class _HaybaBoundedCapture:\n");
    Wrapper += TEXT("    __slots__ = ('_hb_parts', '_hb_count', '_hb_dropped', '_hb_limit')\n");
    Wrapper += TEXT("    def __init__(self, limit):\n");
    Wrapper += TEXT("        self._hb_parts = []; self._hb_count = 0; self._hb_dropped = 0; self._hb_limit = limit\n");
    Wrapper += TEXT("    def write(self, value):\n");
    Wrapper += TEXT("        if type(value) is not str:\n");
    Wrapper += TEXT("            value = '<non-text write omitted by bounded capture>'\n");
    Wrapper += TEXT("        offered = len(value); remaining = self._hb_limit - self._hb_count\n");
    Wrapper += TEXT("        if remaining > 0:\n");
    Wrapper += TEXT("            kept = value[:remaining]\n");
    Wrapper += TEXT("            if kept: self._hb_parts.append(kept); self._hb_count += len(kept)\n");
    Wrapper += TEXT("        self._hb_dropped += max(0, offered - max(0, remaining))\n");
    Wrapper += TEXT("        return offered\n");
    Wrapper += TEXT("    def flush(self):\n");
    Wrapper += TEXT("        pass\n");
    Wrapper += TEXT("    def getvalue(self):\n");
    Wrapper += TEXT("        return ''.join(self._hb_parts)\n");
    Wrapper += FString::Printf(TEXT("_hb_out = _HaybaBoundedCapture(%d); _hb_err = _HaybaBoundedCapture(%d)\n"),
        MaxPythonCapturedCharsPerStream, MaxPythonCapturedCharsPerStream);
    // Deliberately do not call arbitrary object __str__/__repr__ hooks here.
    // Besides allocating without a useful ceiling, Unreal Python wrappers can
    // cross into native C/C++ during conversion. This closes the output-buffer
    // class; general safety for arbitrary native extension calls remains #392
    // and cannot honestly be promised by source preflight. Behavior change:
    // callers that need a container/object value must serialize it explicitly
    // to bounded text (for example a size-limited json.dumps result) before
    // print(); the response advertises capture_value_policy so an AI can adapt.
    Wrapper += TEXT("def _hb_write_value(sink, value):\n");
    Wrapper += TEXT("    value_type = type(value)\n");
    Wrapper += TEXT("    if value_type is str:\n");
    Wrapper += TEXT("        sink.write(value)\n");
    Wrapper += TEXT("    elif value_type is int:\n");
    Wrapper += TEXT("        sink.write(str(value) if value.bit_length() <= 4096 else '<oversized int omitted by bounded capture>')\n");
    Wrapper += TEXT("    elif value_type in (float, bool, complex, type(None)):\n");
    Wrapper += TEXT("        sink.write(str(value))\n");
    Wrapper += TEXT("    elif value_type is bytes:\n");
    Wrapper += TEXT("        remaining = max(0, sink._hb_limit - sink._hb_count)\n");
    Wrapper += TEXT("        sink.write(repr(value[:max(0, remaining // 4)]))\n");
    Wrapper += TEXT("    else:\n");
    Wrapper += TEXT("        sink.write('<non-primitive value omitted by bounded capture>')\n");
    Wrapper += TEXT("def _hb_print(*a, **k):\n");
    Wrapper += TEXT("    _sep = k.get('sep', ' '); _end = k.get('end', '\\n'); _f = k.get('file', None)\n");
    Wrapper += TEXT("    if _sep is None: _sep = ' '\n");
    Wrapper += TEXT("    if _end is None: _end = '\\n'\n");
    Wrapper += TEXT("    if type(_sep) is not str or type(_end) is not str:\n");
    Wrapper += TEXT("        raise TypeError('sep and end must be strings or None')\n");
    Wrapper += TEXT("    _sink = _hb_err if _f is _hb_sys.stderr else _hb_out\n");
    Wrapper += TEXT("    for _index, _value in enumerate(a):\n");
    Wrapper += TEXT("        if _index: _sink.write(_sep)\n");
    Wrapper += TEXT("        _hb_write_value(_sink, _value)\n");
    Wrapper += TEXT("    _sink.write(_end)\n");
    // Keep the enforcement clock, counter, trace callback, and trusted
    // settrace callable in a private function frame. The user code receives a
    // distinct globals dictionary and cannot replace these locals. Saving the
    // bound settrace function before execution also means finally never calls
    // a module attribute that user code could have monkey-patched.
    Wrapper += TEXT("_hb_trusted_settrace = _hb_sys.settrace\n");
    Wrapper += TEXT("_hb_trusted_gettrace = _hb_sys.gettrace\n");
    Wrapper += TEXT("_hb_trusted_monotonic = _hb_time.monotonic\n");
    Wrapper += TEXT("_hb_trusted_gc_collect = _hb_gc.collect\n");
    Wrapper += TEXT("def _hb_execute_user(_hb_user_source, _hb_user_globals, _hb_set_trace, _hb_get_trace, _hb_now, _hb_collect, _hb_system):\n");
    Wrapper += TEXT("    _hb_ok = True; _hb_timed_out = False; _hb_trace_events = 0\n");
    Wrapper += FString::Printf(TEXT("    _hb_deadline = _hb_now() + %.3f\n"), MaxPythonExecutionSeconds);
    Wrapper += TEXT("    class _HaybaDeadlineExceeded(BaseException):\n");
    Wrapper += TEXT("        pass\n");
    Wrapper += TEXT("    def _hb_trace(_frame, _event, _arg):\n");
    Wrapper += TEXT("        nonlocal _hb_trace_events\n");
    Wrapper += TEXT("        _hb_trace_events += 1\n");
    Wrapper += FString::Printf(TEXT("        if (_hb_trace_events %% %d) == 0 and _hb_now() >= _hb_deadline:\n"), PythonDeadlineCheckInterval);
    Wrapper += TEXT("            raise _HaybaDeadlineExceeded()\n");
    Wrapper += TEXT("        return _hb_trace\n");
    Wrapper += TEXT("    _hb_previous_stdout = _hb_system.stdout; _hb_previous_stderr = _hb_system.stderr\n");
    Wrapper += TEXT("    _hb_previous_trace = _hb_get_trace()\n");
    Wrapper += TEXT("    try:\n");
    Wrapper += TEXT("        _hb_system.stdout = _hb_out; _hb_system.stderr = _hb_err\n");
    Wrapper += TEXT("        _hb_set_trace(_hb_trace)\n");
    Wrapper += TEXT("        exec(compile(_hb_user_source, '<hayba>', 'exec'), _hb_user_globals)\n");
    Wrapper += TEXT("    except _HaybaDeadlineExceeded:\n");
    Wrapper += TEXT("        _hb_ok = False\n");
    Wrapper += TEXT("        _hb_timed_out = True\n");
    Wrapper += FString::Printf(TEXT("        _hb_err.write('python_run exceeded %.1f second cooperative bytecode deadline')\n"), MaxPythonExecutionSeconds);
    // Catch BaseException so SystemExit/KeyboardInterrupt cannot escape the
    // one-shot command even if a future alias slips past source preflight.
    Wrapper += TEXT("    except BaseException as _hb_exception:\n");
    Wrapper += TEXT("        _hb_ok = False\n");
    Wrapper += TEXT("        _hb_err.write('Traceback (most recent call last):\\n')\n");
    Wrapper += TEXT("        _hb_tb_cursor = BaseException.__getattribute__(_hb_exception, '__traceback__'); _hb_tb_frames = 0\n");
    Wrapper += TEXT("        while _hb_tb_cursor is not None and _hb_tb_frames < 32:\n");
    Wrapper += TEXT("            _hb_code = _hb_tb_cursor.tb_frame.f_code\n");
    Wrapper += TEXT("            _hb_err.write('  File '); _hb_write_value(_hb_err, _hb_code.co_filename)\n");
    Wrapper += TEXT("            _hb_err.write(', line '); _hb_write_value(_hb_err, _hb_tb_cursor.tb_lineno)\n");
    Wrapper += TEXT("            _hb_err.write(', in '); _hb_write_value(_hb_err, _hb_code.co_name); _hb_err.write('\\n')\n");
    Wrapper += TEXT("            _hb_tb_cursor = _hb_tb_cursor.tb_next; _hb_tb_frames += 1\n");
    Wrapper += TEXT("        if _hb_tb_cursor is not None: _hb_err.write('  <additional frames omitted>\\n')\n");
    Wrapper += TEXT("        _hb_err.write(type.__getattribute__(type(_hb_exception), '__name__')); _hb_err.write(': ')\n");
    // A custom BaseException can override attribute access just like any other
    // Python object. Do not touch .args or call str(exception): both can invoke
    // attacker-controlled/native code while reporting the original failure.
    Wrapper += TEXT("        _hb_err.write('<exception arguments omitted by bounded capture>\\n')\n");
    // CPython disables tracing if the trace callback itself raises. Reinstall
    // the trusted trace before dropping request globals so hostile __del__ code
    // remains deadline-bounded. Restore any host trace only after clear/GC and
    // stream restoration have finished.
    Wrapper += TEXT("    finally:\n");
    Wrapper += TEXT("        try:\n");
    Wrapper += TEXT("            try:\n");
    Wrapper += TEXT("                _hb_set_trace(_hb_trace)\n");
    Wrapper += TEXT("                _hb_user_globals.clear()\n");
    Wrapper += TEXT("                _hb_collect()\n");
    Wrapper += TEXT("            except _HaybaDeadlineExceeded:\n");
    Wrapper += TEXT("                _hb_ok = False; _hb_timed_out = True\n");
    Wrapper += TEXT("                _hb_err.write('python_run cleanup exceeded the cooperative bytecode deadline')\n");
    Wrapper += TEXT("            except BaseException:\n");
    Wrapper += TEXT("                _hb_ok = False\n");
    Wrapper += TEXT("                _hb_err.write('python_run request-global cleanup failed safely')\n");
    Wrapper += TEXT("        finally:\n");
    Wrapper += TEXT("            try:\n");
    Wrapper += TEXT("                _hb_system.stdout = _hb_previous_stdout; _hb_system.stderr = _hb_previous_stderr\n");
    Wrapper += TEXT("            finally:\n");
    Wrapper += TEXT("                _hb_set_trace(_hb_previous_trace)\n");
    Wrapper += TEXT("    return _hb_ok, _hb_timed_out\n");
    // Give user code a private globals dictionary and a private copy of the
    // builtin-name mapping. Importing the process-global builtins module is
    // rejected lexically above, so simple assignments cannot poison readback
    // and cleanup helpers after the request completes.
    Wrapper += TEXT("_hb_user_builtins = _hb_b.__dict__.copy()\n");
    // Deleting the request-global print name must not fall through to the real
    // process built-in, which would invoke arbitrary object __str__/__repr__.
    Wrapper += TEXT("_hb_user_builtins['print'] = _hb_print\n");
    Wrapper += TEXT("_hb_g = {'print': _hb_print, '__name__': '__hayba_user__', '__builtins__': _hb_user_builtins}\n");
    Wrapper += TEXT("_hb_ok, _hb_timed_out = _hb_execute_user(_hb_src, _hb_g, _hb_trusted_settrace, _hb_trusted_gettrace, _hb_trusted_monotonic, _hb_trusted_gc_collect, _hb_sys)\n");
    Wrapper += TEXT("_hb_b._hayba_out = _hb_out.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_err = _hb_err.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_capture_meta = '%d,%d,%d,%d' % (int(_hb_out._hb_dropped > 0), int(_hb_err._hb_dropped > 0), _hb_out._hb_dropped, _hb_err._hb_dropped)\n");
    Wrapper += TEXT("_hb_b._hayba_ok = _hb_ok\n");
    Wrapper += TEXT("_hb_b._hayba_timed_out = _hb_timed_out\n");
    // The execution function already dropped the script namespace and forced a
    // CPython collection while its trusted trace remained active and while
    // still inside the SEH-guarded ExecPythonCommandEx below. This targets
    // the python311 -> PythonScriptPlugin -> CoreUObject access-violation class:
    // a one-shot script creates a Python wrapper for a UObject it spawns/edits,
    // that UObject is later destroyed (or the wrapper otherwise dangles), and the
    // wrapper lingers in `_hb_g` long after Run() returns. CPython then collects
    // it on some LATER allocation/tick — outside any __try — and the stale
    // reference faults fatally (the engine had no chance to catch it). By clearing
    // `_hb_g` and calling gc.collect() here, the wrapper is finalised NOW, inside
    // the guard: if finalisation is going to fault it does so where the SEH guard
    // converts it to a recoverable error, and if it doesn't fault the dangling
    // reference is gone before the next engine GC can trip over it. The
    // wrapper-local capture buffers (_hb_out/_hb_err/_hb_ok) are NOT in `_hb_g`,
    // so the result stash performed immediately after the function returns is
    // unaffected.
    // Cleanup exceptions are contained by the execution function before it
    // restores the previous trace hook.

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
    bool bCaptureMetaReadCrashed = false;
    const FString StdOut = EvalB64(TEXT("_hayba_out"), bStdOutReadCrashed);
    const FString StdErr = EvalB64(TEXT("_hayba_err"), bStdErrReadCrashed);
    const FString CaptureMeta = EvalB64(TEXT("_hayba_capture_meta"), bCaptureMetaReadCrashed);
    if (bStdOutReadCrashed || bStdErrReadCrashed || bCaptureMetaReadCrashed)
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

    FPythonCommandEx CleanupCmd;
    CleanupCmd.Command = TEXT(
        "import builtins as _hb_cleanup_b\n"
        "for _hb_cleanup_name in ('_hayba_out','_hayba_err','_hayba_capture_meta','_hayba_ok','_hayba_timed_out'):\n"
        "    if hasattr(_hb_cleanup_b, _hb_cleanup_name): delattr(_hb_cleanup_b, _hb_cleanup_name)\n");
    CleanupCmd.ExecutionMode = EPythonCommandExecutionMode::ExecuteFile;
    bool bCleanupCrashed = false;
    ExecPythonGuarded(PythonPlugin, &CleanupCmd, bCleanupCrashed);
    if (bCleanupCrashed)
    {
        return FHaybaHandlerResult::Err(TEXT(
            "python_run fatal_error [HCR-NATIVE-002]: matched 'post_execution_cleanup_access_violation'. "
            "The interpreter faulted while releasing bounded capture state. Safe alternative: restart the disposable "
            "editor before retrying and use typed handlers for native objects. Retry unchanged: forbidden; editor "
            "session health is suspect."));
    }

    if (bTimedOut)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("python_run policy_blocked [HCR-TIME-001]: matched 'execution_deadline'; Python bytecode exceeded the %.1f second cooperative deadline. Safe alternative: split the work into bounded requests or implement an owned native job and poll it. Retry unchanged: forbidden. Native UE/C-extension calls cannot be interrupted safely and must be refused by preflight instead."),
            MaxPythonExecutionSeconds));
    }

    TSharedPtr<FJsonObject> Out = MakeShareable(new FJsonObject());
    Out->SetBoolField(TEXT("ok"), bExecOk && bUserOk);
    Out->SetNumberField(TEXT("tier"), static_cast<int32>(Tier));
    Out->SetBoolField(TEXT("allow_unsafe_requested"), bAllowUnsafeRequested);
    Out->SetBoolField(TEXT("allow_unsafe_effective"), false);
    Out->SetBoolField(TEXT("allow_unsafe_deprecated"), true);
    Out->SetStringField(TEXT("stdout"), StdOut);
    Out->SetStringField(TEXT("stderr"), StdErr);

    TArray<FString> CaptureFacts;
    CaptureMeta.ParseIntoArray(CaptureFacts, TEXT(","), false);
    const bool bStdOutTruncated = CaptureFacts.IsValidIndex(0) && CaptureFacts[0] == TEXT("1");
    const bool bStdErrTruncated = CaptureFacts.IsValidIndex(1) && CaptureFacts[1] == TEXT("1");
    const int64 StdOutCharsDropped = CaptureFacts.IsValidIndex(2) ? FCString::Atoi64(*CaptureFacts[2]) : 0;
    const int64 StdErrCharsDropped = CaptureFacts.IsValidIndex(3) ? FCString::Atoi64(*CaptureFacts[3]) : 0;
    Out->SetBoolField(TEXT("stdout_truncated"), bStdOutTruncated);
    Out->SetBoolField(TEXT("stderr_truncated"), bStdErrTruncated);
    Out->SetNumberField(TEXT("stdout_chars_dropped"), static_cast<double>(FMath::Max<int64>(0, StdOutCharsDropped)));
    Out->SetNumberField(TEXT("stderr_chars_dropped"), static_cast<double>(FMath::Max<int64>(0, StdErrCharsDropped)));
    Out->SetNumberField(TEXT("capture_limit_chars_per_stream"), MaxPythonCapturedCharsPerStream);
    Out->SetStringField(TEXT("capture_value_policy"), TEXT("bounded_primitive_only"));

    return FHaybaHandlerResult::Ok(Out);
}
