#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPChooserHandler.h"
#include "HaybaMCPCommandSets.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPSettings.h"
#include "Serialization/JsonSerializer.h"

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

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaChooserOutputTest, "Hayba.Chooser.OutputEnvelope",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FHaybaChooserOutputTest::RunTest(const FString&)
{
    class FOutputHandler : public IHaybaMCPHandler
    {
    public:
        FString Output;
        FString GetDomain() const override { return TEXT("chooser_output_test"); }
        TArray<FString> GetCommands() const override { return { TEXT("chooser_inspect") }; }
        FHaybaHandlerResult Handle(const FString&, const TSharedPtr<FJsonObject>&) override
        {
            auto Data = MakeShared<FJsonObject>();
            Data->SetStringField(TEXT("output"), Output);
            return FHaybaHandlerResult::Ok(Data);
        }
    };
    auto Handler = MakeShared<FOutputHandler>();
    Handler->Output = TEXT("HAYBA_JSON:{\"ok\":true,\"text\":\"") + FString::ChrN(2048, TEXT('x')) + TEXT("\"}\n");
    FHaybaMCPCommandHandler Router;
    Router.RegisterHandler(Handler);
    auto Request = MakeShared<FJsonObject>();
    Request->SetStringField(TEXT("id"), TEXT("chooser-output-test"));
    Request->SetStringField(TEXT("cmd"), TEXT("chooser_inspect"));
    Request->SetStringField(TEXT("auth"), FHaybaMCPSettings::Get().CapabilityToken);
    Request->SetObjectField(TEXT("params"), MakeShared<FJsonObject>());
    FString Json;
    FJsonSerializer::Serialize(Request.ToSharedRef(), TJsonWriterFactory<>::Create(&Json));
    TSharedPtr<FJsonObject> Reply;
    const FString Wire = Router.ProcessCommand(Json);
    if (!TestTrue(TEXT("Router returns JSON"), FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Wire), Reply)) || !Reply) return false;
    if (!TestTrue(TEXT("Named read routes successfully"), Reply->GetBoolField(TEXT("ok")))) return false;
    TestEqual(TEXT("Machine-readable stdout survives generic response shaping"),
        Reply->GetObjectField(TEXT("data"))->GetStringField(TEXT("output")), Handler->Output);
    return true;
}
#endif
