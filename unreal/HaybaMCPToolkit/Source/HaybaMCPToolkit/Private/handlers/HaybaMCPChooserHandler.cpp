#include "HaybaMCPChooserHandler.h"
#include "HaybaMCPPythonHandler.h"
#include "HaybaMCPParams.h"
#include "Interfaces/IPluginManager.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Policies/CondensedJsonPrintPolicy.h"

TArray<FString> FHaybaMCPChooserHandler::GetCommands() const
{
    return { TEXT("chooser_inspect") };
}

bool FHaybaMCPChooserHandler::BuildRequest(const TSharedPtr<FJsonObject>& Params,
    TSharedPtr<FJsonObject>& OutPython, FString& OutError)
{
    OutPython.Reset();
    OutError = HaybaUnknownParamsError(Params, TEXT("chooser_inspect"),
        {TEXT("path"), TEXT("row_offset"), TEXT("row_limit"), TEXT("column_offset"), TEXT("column_limit")});
    if (!OutError.IsEmpty()) return false;
    FHaybaParamReader Reader(Params, TEXT("chooser_inspect"));
    const FString Path = Reader.RequiredString(TEXT("path"), 4096).TrimStartAndEnd();
    const double RowOffset = Reader.OptionalNumber(TEXT("row_offset"), 0);
    const double RowLimit = Reader.OptionalNumber(TEXT("row_limit"), 10);
    const double ColumnOffset = Reader.OptionalNumber(TEXT("column_offset"), 0);
    const double ColumnLimit = Reader.OptionalNumber(TEXT("column_limit"), 8);
    if (Reader.HasErrors()) { OutError = Reader.ErrorMessage(); return false; }
    if (!FPackageName::IsValidLongPackageName(Path) && !FPackageName::IsValidObjectPath(Path))
    { OutError = TEXT("chooser_inspect requires an exact content package or object path."); return false; }
    auto InRange = [](double Value, double Min, double Max)
    { return FMath::IsFinite(Value) && Value >= Min && Value <= Max && FMath::FloorToDouble(Value) == Value; };
    if (!InRange(RowOffset, 0, MAX_int32) || !InRange(ColumnOffset, 0, MAX_int32) ||
        !InRange(RowLimit, 1, 20) || !InRange(ColumnLimit, 1, 8))
    { OutError = TEXT("chooser_inspect requires integer offsets 0..2147483647, row_limit 1..20 and column_limit 1..8."); return false; }
    const auto Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    if (!Plugin) { OutError = TEXT("Hayba's bundled Chooser inspector is unavailable."); return false; }
    const FString ScriptPath = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources/Python/hayba_chooser_inspect.py"));
    const int64 Size = IFileManager::Get().FileSize(*ScriptPath);
    FString Script;
    if (Size <= 0 || Size > 65536 || !FFileHelper::LoadFileToString(Script, *ScriptPath))
    { OutError = TEXT("Hayba's bundled Chooser inspector is missing or invalid. Repair the plugin installation."); return false; }
    auto Clean = MakeShared<FJsonObject>();
    Clean->SetStringField(TEXT("path"), Path);
    Clean->SetNumberField(TEXT("row_offset"), RowOffset);
    Clean->SetNumberField(TEXT("row_limit"), RowLimit);
    Clean->SetNumberField(TEXT("column_offset"), ColumnOffset);
    Clean->SetNumberField(TEXT("column_limit"), ColumnLimit);
    FString Json, Literal;
    FJsonSerializer::Serialize(Clean, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Json));
    const auto Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Literal);
    Writer->WriteValue(Json);
    Writer->Close();
    OutPython = MakeShared<FJsonObject>();
    OutPython->SetStringField(TEXT("script"), TEXT("import json as _json\n_hayba_params = _json.loads(") + Literal + TEXT(")\n") + Script);
    OutPython->SetBoolField(TEXT("read_only"), true);
    return true;
}

FHaybaHandlerResult FHaybaMCPChooserHandler::Handle(const FString& Command, const TSharedPtr<FJsonObject>& Params)
{
    if (Command != TEXT("chooser_inspect")) return FHaybaHandlerResult::Err(TEXT("Unknown Chooser command."));
    if (!IsInGameThread()) return FHaybaHandlerResult::Err(TEXT("Chooser inspection requires the editor game thread."));
    TSharedPtr<FJsonObject> PythonParams;
    FString Error;
    if (!BuildRequest(Params, PythonParams, Error)) return FHaybaHandlerResult::Err(Error);
    // A named read operation executes only trusted plugin code under the inherited
    // request/lease. Caller python_run still goes through exact-review admission.
    FHaybaMCPPythonHandler Python;
    return Python.Handle(TEXT("python_run"), PythonParams);
}
