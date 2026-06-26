#include "HaybaMCPPythonHandler.h"
#include "HaybaMCPSettings.h"
#include "IPythonScriptPlugin.h"
#include "PythonScriptTypes.h"
#include "Misc/Base64.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#if PLATFORM_WINDOWS
#include <excpt.h>   // EXCEPTION_EXECUTE_HANDLER for the SEH guard below
#endif

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

// Detect the registration patterns behind the dangling-delegate crash class
// (#283/#284): a python_run script binds a UE editor delegate / tick / shutdown
// callback to a Python callable that later gets garbage-collected, and the next
// engine broadcast dereferences the freed target -> native access violation at
// whatever call site triggers it (RecompileMaterial, PostEditChange, …). The
// SEH guards keep the editor alive, but the fix is to not create the dangling
// binding in the first place. We WARN (not block — one-shot ops are fine and
// some callbacks are legitimate if a reference is kept) so the agent stops
// leaking persistent callbacks across python_run calls.
static TArray<FString> DetectRiskyDelegatePatterns(const FString& Code)
{
    // pattern -> why it's risky
    static const TArray<TPair<FString, FString>> Patterns = {
        { TEXT("register_slate_post_tick_callback"), TEXT("per-frame Slate tick callback") },
        { TEXT("register_slate_pre_tick_callback"),  TEXT("per-frame Slate tick callback") },
        { TEXT("register_python_shutdown_callback"), TEXT("shutdown callback") },
        { TEXT("register_post_engine_init_callback"),TEXT("engine-init callback") },
        { TEXT(".add_callable_unique("),             TEXT("delegate binding (add_callable_unique)") },
        { TEXT(".add_callable("),                    TEXT("delegate binding (add_callable)") },
        { TEXT(".add_function("),                    TEXT("delegate binding (add_function)") },
        { TEXT(".bind_callable("),                   TEXT("delegate binding (bind_callable)") },
        { TEXT("unreal.register_"),                  TEXT("editor callback registration") },
    };
    TArray<FString> Warnings;
    for (const TPair<FString, FString>& P : Patterns)
    {
        if (Code.Contains(P.Key))
        {
            Warnings.Add(FString::Printf(
                TEXT("dangling-delegate risk: '%s' (%s). The Python callable must be kept alive for the editor's lifetime, or it is garbage-collected and the next engine broadcast crashes with an access violation (the #283/#284 crash class). Prefer one-shot operations inside this python_run call; do NOT register persistent editor delegates/tick/shutdown callbacks from python_run. If you must, store the callable on a module-global so it is never collected."),
                *P.Key, *P.Value));
        }
    }
    return Warnings;
}

EPythonTier FHaybaMCPPythonHandler::ClassifyScript(const FString& Code)
{
    static const TArray<FString> Tier3Keywords = {
        TEXT("subprocess"), TEXT("os.system"), TEXT("os.popen"),
        TEXT("open("), TEXT("__import__"), TEXT("eval("),
        TEXT("compile("), TEXT("shutil"), TEXT("socket")
    };
    static const TArray<FString> Tier2Keywords = {
        TEXT("spawn_actor"), TEXT("destroy_actor"), TEXT("set_property"),
        TEXT("create_asset"), TEXT("delete_asset"), TEXT(".save_"),
        TEXT("EditorAssetLibrary"), TEXT("EditorActorSubsystem")
    };

    for (const FString& K : Tier3Keywords)
    {
        if (Code.Contains(K)) return EPythonTier::Unsafe;
    }
    for (const FString& K : Tier2Keywords)
    {
        if (Code.Contains(K)) return EPythonTier::Mutation;
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

    // Optional per-call unsafe override
    bool bAllowUnsafeOverride = false;
    P->TryGetBoolField(TEXT("allow_unsafe"), bAllowUnsafeOverride);

    // Classify
    EPythonTier Tier = ClassifyScript(Code);

    // Block Tier 3 if not allowed
    if (Tier == EPythonTier::Unsafe)
    {
        const bool bSettingAllows = FHaybaMCPSettings::Get().bAllowUnsafePython;
        if (!bSettingAllows && !bAllowUnsafeOverride)
        {
            return FHaybaHandlerResult::Err(
                TEXT("Tier 3 (filesystem/subprocess) blocked. Set AllowUnsafePython=true in plugin settings to override."));
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
    Wrapper += TEXT("import io as _hb_io, traceback as _hb_tb, builtins as _hb_b, base64 as _hb_64\n");
    Wrapper += FString::Printf(TEXT("_hb_src = _hb_64.b64decode('%s').decode('utf-8')\n"), *CodeB64);
    Wrapper += TEXT("_hb_out = _hb_io.StringIO(); _hb_err = _hb_io.StringIO()\n");
    Wrapper += TEXT("def _hb_print(*a, **k):\n");
    Wrapper += TEXT("    _sep = k.get('sep', ' '); _end = k.get('end', '\\n'); _f = k.get('file', None)\n");
    Wrapper += TEXT("    _line = _sep.join([str(_x) for _x in a]) + _end\n");
    Wrapper += TEXT("    (_hb_err if _f is not None else _hb_out).write(_line)\n");
    Wrapper += TEXT("_hb_g = {'print': _hb_print, '__name__': '__main__'}\n");
    Wrapper += TEXT("_hb_ok = True\n");
    Wrapper += TEXT("try:\n");
    Wrapper += TEXT("    exec(compile(_hb_src, '<hayba>', 'exec'), _hb_g)\n");
    Wrapper += TEXT("except Exception:\n");
    Wrapper += TEXT("    _hb_ok = False\n");
    Wrapper += TEXT("    _hb_err.write(_hb_tb.format_exc())\n");
    Wrapper += TEXT("_hb_b._hayba_out = _hb_out.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_err = _hb_err.getvalue()\n");
    Wrapper += TEXT("_hb_b._hayba_ok = _hb_ok\n");

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
            "python_run: native access violation during script execution. The script "
            "dereferenced an invalid object — typically a stale/destroyed actor or "
            "component handle, a garbage-collected UObject held across ticks, or a "
            "re-entrant editor mutation. The editor was kept alive by the SEH guard; "
            "re-acquire handles fresh inside the run (do not cache UObject references "
            "between python_run calls) and avoid mutating the level while iterating it."));
    }

    // Evaluate a base64 expression and decode the result back to a string.
    auto EvalB64 = [PythonPlugin](const FString& Attr) -> FString
    {
        FPythonCommandEx E;
        E.Command = FString::Printf(
            TEXT("__import__('base64').b64encode((getattr(__import__('builtins'),'%s','') or '').encode('utf-8')).decode('ascii')"),
            *Attr);
        E.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
        PythonPlugin->ExecPythonCommandEx(E);
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

    const FString StdOut = EvalB64(TEXT("_hayba_out"));
    const FString StdErr = EvalB64(TEXT("_hayba_err"));

    FPythonCommandEx OkCmd;
    OkCmd.Command = TEXT("repr(getattr(__import__('builtins'),'_hayba_ok',True))");
    OkCmd.ExecutionMode = EPythonCommandExecutionMode::EvaluateStatement;
    PythonPlugin->ExecPythonCommandEx(OkCmd);
    const bool bUserOk = !OkCmd.CommandResult.Contains(TEXT("False"));

    TSharedPtr<FJsonObject> Out = MakeShareable(new FJsonObject());
    Out->SetBoolField(TEXT("ok"), bExecOk && bUserOk);
    Out->SetNumberField(TEXT("tier"), static_cast<int32>(Tier));
    Out->SetStringField(TEXT("stdout"), StdOut);
    Out->SetStringField(TEXT("stderr"), StdErr);

    // Surface dangling-delegate registration risks (the root cause behind the
    // #283/#284 native AVs) so the agent stops leaking persistent callbacks.
    const TArray<FString> DelegateWarnings = DetectRiskyDelegatePatterns(Code);
    if (DelegateWarnings.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> Warr;
        for (const FString& W : DelegateWarnings) Warr.Add(MakeShareable(new FJsonValueString(W)));
        Out->SetArrayField(TEXT("warnings"), Warr);
    }

    return FHaybaHandlerResult::Ok(Out);
}
