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
    constexpr int32 MaxPythonPolicyExpandedChars = MaxPythonScriptChars * 4;
    constexpr int32 MaxPythonPolicyPathChars = 4096;
    constexpr int32 MaxPythonPolicyPathComponents = 64;
    constexpr int32 MaxPythonPolicyFStringDepth = 16;
    constexpr int32 MaxPythonPolicyTokens = MaxPythonScriptChars;
    constexpr int32 MaxPythonPolicyLexedChars = MaxPythonPolicyExpandedChars;
    constexpr int32 MaxPythonCapturedCharsPerStream = 64 * 1024;
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

    bool ReadDottedPythonName(
        const TArray<FPythonPolicyToken>& Tokens,
        int32& Index,
        FString& OutName)
    {
        if (!TokenIsIdentifier(Tokens, Index)) return false;
        OutName = Tokens[Index++].Text;
        while (Tokens.IsValidIndex(Index + 1)
            && Tokens[Index].Kind == EPythonPolicyTokenKind::Dot
            && TokenIsIdentifier(Tokens, Index + 1))
        {
            OutName += TEXT(".");
            OutName += Tokens[Index + 1].Text;
            Index += 2;
        }
        return true;
    }

    FString FirstPythonNameComponent(const FString& Name)
    {
        int32 Dot = INDEX_NONE;
        return Name.FindChar(TEXT('.'), Dot) ? Name.Left(Dot) : Name;
    }

    bool ApplyPythonImportAliasesAt(
        const TArray<FPythonPolicyToken>& Tokens,
        const int32 Cursor,
        TMap<FString, FString>& Aliases,
        int32& OutAfter)
    {
        OutAfter = Cursor + 1;
        if (TokenIsIdentifier(Tokens, Cursor, TEXT("import")))
        {
            int32 At = Cursor + 1;
            while (At < Tokens.Num())
            {
                FString Imported;
                if (!ReadDottedPythonName(Tokens, At, Imported)) break;

                FString Local = FirstPythonNameComponent(Imported);
                if (TokenIsIdentifier(Tokens, At, TEXT("as")) && TokenIsIdentifier(Tokens, At + 1))
                {
                    Local = Tokens[At + 1].Text;
                    At += 2;
                }
                Aliases.Add(Local, Imported);

                if (!Tokens.IsValidIndex(At) || Tokens[At].Kind != EPythonPolicyTokenKind::Comma) break;
                ++At;
            }
            OutAfter = At;
            return true;
        }

        if (!TokenIsIdentifier(Tokens, Cursor, TEXT("from"))) return false;
        int32 At = Cursor + 1;
        FString Module;
        if (!ReadDottedPythonName(Tokens, At, Module) || !TokenIsIdentifier(Tokens, At, TEXT("import")))
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
            if (Tokens[At].Kind == EPythonPolicyTokenKind::Comma)
            {
                ++At;
                continue;
            }

            FString Imported;
            if (!ReadDottedPythonName(Tokens, At, Imported)) break;
            FString Local = FirstPythonNameComponent(Imported);
            if (TokenIsIdentifier(Tokens, At, TEXT("as")) && TokenIsIdentifier(Tokens, At + 1))
            {
                Local = Tokens[At + 1].Text;
                At += 2;
            }
            Aliases.Add(Local, Module + TEXT(".") + Imported);
        }
        OutAfter = At;
        return true;
    }

    FString ResolvePythonAliasPath(const FString& Path, const TMap<FString, FString>& Aliases)
    {
        const FString First = FirstPythonNameComponent(Path);
        const FString* Target = Aliases.Find(First);
        if (!Target) return Path;
        return *Target + Path.Mid(First.Len());
    }

    FString BuildAliasExpandedPythonCalls(const FString& Code)
    {
        const TArray<FPythonPolicyToken> Tokens = LexPythonPolicySource(Code);
        TMap<FString, FString> Aliases;
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
            if (ApplyPythonImportAliasesAt(Tokens, Cursor, Aliases, AfterImport))
            {
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
                const bool bHasAssignedPath = ReadDottedPythonName(Tokens, AfterValue, AssignedPath);
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
                        const FString Resolved = ResolvePythonAliasPath(AssignedPath, Aliases);
                        Aliases.Add(Local, Resolved);
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
                Aliases.Remove(Local);
                ++Cursor;
                continue;
            }

            int32 At = Cursor;
            FString Path;
            if (!ReadDottedPythonName(Tokens, At, Path)) continue;

            // Treat a reference to a fatal callable as fatal even when the
            // immediate syntax is not `name(...)`. Otherwise trivial Python
            // indirection such as `f = process.abort; f()` or
            // `process.abort.__call__()` evades source preflight. Appending an
            // opening parenthesis lets the existing exact callable rules judge
            // the canonical path without attempting unsafe data-flow analysis.
            const FString Resolved = ResolvePythonAliasPath(Path, Aliases);
            AppendReference(Resolved);
            Cursor = At - 1;
        }
        return Expanded;
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
            if (CompactContainsPolicyPattern(Compact, Rule.Pattern)
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
    Wrapper += TEXT("import builtins as _hb_b, base64 as _hb_64, sys as _hb_sys, time as _hb_time\n");
    Wrapper += FString::Printf(TEXT("_hb_src = _hb_64.b64decode('%s').decode('utf-8')\n"), *CodeB64);
    Wrapper += TEXT("class _HaybaBoundedCapture:\n");
    Wrapper += TEXT("    __slots__ = ('_parts', '_count', '_dropped', '_limit')\n");
    Wrapper += TEXT("    def __init__(self, limit):\n");
    Wrapper += TEXT("        self._parts = []; self._count = 0; self._dropped = 0; self._limit = limit\n");
    Wrapper += TEXT("    def write(self, value):\n");
    Wrapper += TEXT("        if type(value) is not str:\n");
    Wrapper += TEXT("            value = '<non-text write omitted by bounded capture>'\n");
    Wrapper += TEXT("        offered = len(value); remaining = self._limit - self._count\n");
    Wrapper += TEXT("        if remaining > 0:\n");
    Wrapper += TEXT("            kept = value[:remaining]\n");
    Wrapper += TEXT("            if kept: self._parts.append(kept); self._count += len(kept)\n");
    Wrapper += TEXT("        self._dropped += max(0, offered - max(0, remaining))\n");
    Wrapper += TEXT("        return offered\n");
    Wrapper += TEXT("    def flush(self):\n");
    Wrapper += TEXT("        pass\n");
    Wrapper += TEXT("    def getvalue(self):\n");
    Wrapper += TEXT("        return ''.join(self._parts)\n");
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
    Wrapper += TEXT("        remaining = max(0, sink._limit - sink._count)\n");
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
    Wrapper += TEXT("_hb_previous_stdout = _hb_sys.stdout; _hb_previous_stderr = _hb_sys.stderr\n");
    Wrapper += TEXT("try:\n");
    Wrapper += TEXT("    _hb_sys.stdout = _hb_out; _hb_sys.stderr = _hb_err\n");
    Wrapper += TEXT("    _hb_sys.settrace(_hb_trace)\n");
    Wrapper += TEXT("    exec(compile(_hb_src, '<hayba>', 'exec'), _hb_g)\n");
    Wrapper += TEXT("except _HaybaDeadlineExceeded as _hb_timeout_error:\n");
    Wrapper += TEXT("    _hb_ok = False\n");
    Wrapper += TEXT("    _hb_timed_out = True\n");
    Wrapper += TEXT("    _hb_err.write(str(_hb_timeout_error))\n");
    // Catch BaseException so SystemExit/KeyboardInterrupt cannot escape the
    // one-shot command even if a future alias slips past source preflight.
    Wrapper += TEXT("except BaseException as _hb_exception:\n");
    Wrapper += TEXT("    _hb_ok = False\n");
    Wrapper += TEXT("    _hb_err.write('Traceback (most recent call last):\\n')\n");
    Wrapper += TEXT("    _hb_tb_cursor = BaseException.__getattribute__(_hb_exception, '__traceback__'); _hb_tb_frames = 0\n");
    Wrapper += TEXT("    while _hb_tb_cursor is not None and _hb_tb_frames < 32:\n");
    Wrapper += TEXT("        _hb_code = _hb_tb_cursor.tb_frame.f_code\n");
    Wrapper += TEXT("        _hb_err.write('  File '); _hb_write_value(_hb_err, _hb_code.co_filename)\n");
    Wrapper += TEXT("        _hb_err.write(', line '); _hb_write_value(_hb_err, _hb_tb_cursor.tb_lineno)\n");
    Wrapper += TEXT("        _hb_err.write(', in '); _hb_write_value(_hb_err, _hb_code.co_name); _hb_err.write('\\n')\n");
    Wrapper += TEXT("        _hb_tb_cursor = _hb_tb_cursor.tb_next; _hb_tb_frames += 1\n");
    Wrapper += TEXT("    if _hb_tb_cursor is not None: _hb_err.write('  <additional frames omitted>\\n')\n");
    Wrapper += TEXT("    _hb_err.write(type.__getattribute__(type(_hb_exception), '__name__')); _hb_err.write(': ')\n");
    // A custom BaseException can override attribute access just like any other
    // Python object. Do not touch .args or call str(exception): both can invoke
    // attacker-controlled/native code while reporting the original failure.
    Wrapper += TEXT("    _hb_err.write('<exception arguments omitted by bounded capture>\\n')\n");
    Wrapper += TEXT("finally:\n");
    Wrapper += TEXT("    _hb_sys.settrace(None)\n");
    Wrapper += TEXT("    _hb_sys.stdout = _hb_previous_stdout; _hb_sys.stderr = _hb_previous_stderr\n");
    Wrapper += TEXT("_hb_b._hayba_out = _hb_out.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_err = _hb_err.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_capture_meta = '%d,%d,%d,%d' % (int(_hb_out._dropped > 0), int(_hb_err._dropped > 0), _hb_out._dropped, _hb_err._dropped)\n");
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
