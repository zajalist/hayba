#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPChooserHandler.h"
#include "HaybaMCPCommandSets.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChooserBoundaryTest, "Hayba.Chooser.InputBoundary",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaChooserBoundaryTest::RunTest(const FString&)
{
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("path"), TEXT("/Game/Chooser/CT_Test.CT_Test"));
    TSharedPtr<FJsonObject> Python;
    FString Error;
    TestTrue(TEXT("Named command is a read"), HaybaMCPCommandSets::ReadCommands().Contains(TEXT("chooser_inspect")));
    TestTrue(TEXT("Valid bounded request builds fixed script"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
    if (Python)
    {
        TestTrue(TEXT("Inherited execution declares read only"), Python->GetBoolField(TEXT("read_only")));
        const FString Script = Python->GetStringField(TEXT("script"));
        TestTrue(TEXT("Data is JSON encoded, not interpolated Python"), Script.Contains(TEXT("_hayba_params = _json.loads(\"{\\\"path\\\":")));
        TestTrue(TEXT("Bundled inspector included"), Script.Contains(TEXT("def _inspect_chooser():")));
    }
    for (const TCHAR* Field : { TEXT("script"), TEXT("script_path"), TEXT("read_only") })
    {
        Params->SetStringField(Field, TEXT("raise RuntimeError('caller code')"));
        TestFalse(TEXT("Caller code/authority fields rejected"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
        TestFalse(TEXT("Rejected request has no executable script"), Python.IsValid());
        Params->RemoveField(Field);
    }
    Params->SetNumberField(TEXT("row_limit"), 21);
    TestFalse(TEXT("Row cap enforced natively"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
    Params->RemoveField(TEXT("row_limit"));
    Params->SetNumberField(TEXT("column_limit"), 1.5);
    TestFalse(TEXT("Fractional page size rejected"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
    Params->RemoveField(TEXT("column_limit"));
    Params->SetNumberField(TEXT("row_offset"), -1);
    TestFalse(TEXT("Negative offset rejected"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
    Params->RemoveField(TEXT("row_offset"));
    Params->SetStringField(TEXT("path"), TEXT("/Game/X');raise RuntimeError('caller code')#"));
    TestFalse(TEXT("Injection-shaped asset path rejected"), FHaybaMCPChooserHandler::BuildRequest(Params, Python, Error));
    return true;
}
#endif
