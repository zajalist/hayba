#include "HaybaMCPPythonHandler.h"
#include "HaybaMCPSettings.h"
#include "IPythonScriptPlugin.h"
#include "PythonScriptTypes.h"

TArray<FString> FHaybaMCPPythonHandler::GetCommands() const
{
    return { TEXT("python_run") };
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

    // Execute
    FPythonCommandEx Cmd;
    Cmd.Command = Code;
    Cmd.ExecutionMode = EPythonCommandExecutionMode::ExecuteStatement;
    Cmd.Flags = EPythonCommandFlags::CaptureOutput;

    const bool bOk = PythonPlugin->ExecPythonCommandEx(Cmd);

    // Build result
    TSharedPtr<FJsonObject> Out = MakeShareable(new FJsonObject());
    Out->SetBoolField(TEXT("ok"), bOk);
    Out->SetNumberField(TEXT("tier"), static_cast<int32>(Tier));
    Out->SetStringField(TEXT("stdout"), Cmd.CommandResult);
    if (!Cmd.CommandResultErrors.IsEmpty())
    {
        Out->SetStringField(TEXT("stderr"), Cmd.CommandResultErrors);
    }

    return FHaybaHandlerResult::Ok(Out);
}
