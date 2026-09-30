#include "Misc/AutomationTest.h"
#include "handlers/HaybaMCPEditorHandler.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaMCPEditorStateNativeTest,
    "Hayba.MCP.Editor.GetStateNative",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaMCPEditorStateNativeTest::RunTest(const FString& Parameters)
{
    FHaybaMCPEditorHandler Handler;
    TestTrue(TEXT("native editor handler advertises editor_get_state"),
        Handler.GetCommands().Contains(TEXT("editor_get_state")));

    const FHaybaHandlerResult Result = Handler.Handle(
        TEXT("editor_get_state"), MakeShared<FJsonObject>());
    if (TestTrue(TEXT("native editor_get_state succeeds"), Result.bOk)
        && TestTrue(TEXT("native state has data"), Result.Data.IsValid()))
    {
        TestTrue(TEXT("state contains pie_running"), Result.Data->HasField(TEXT("pie_running")));
        TestTrue(TEXT("state contains selection_count"), Result.Data->HasField(TEXT("selection_count")));
        TestTrue(TEXT("state contains dirty_packages"), Result.Data->HasField(TEXT("dirty_packages")));
        TestTrue(TEXT("state contains dirty_count"), Result.Data->HasField(TEXT("dirty_count")));
        for (const TCHAR* Field : { TEXT("pie"), TEXT("pie_phase"), TEXT("pie_since_s"), TEXT("pie_simulating"),
            TEXT("compiling"), TEXT("shader_jobs"), TEXT("saving"), TEXT("building"), TEXT("caller_owner") })
        {
            TestTrue(*FString::Printf(TEXT("state contains %s"), Field), Result.Data->HasField(Field));
        }
    }
    TSharedPtr<FJsonObject> NoDirty = MakeShared<FJsonObject>();
    NoDirty->SetBoolField(TEXT("include_dirty"), false);
    const FHaybaHandlerResult Skipped = Handler.Handle(TEXT("editor_get_state"), NoDirty);
    if (TestTrue(TEXT("include_dirty:false succeeds"), Skipped.bOk && Skipped.Data.IsValid()))
    {
        TestFalse(TEXT("include_dirty:false has no dirty_packages"), Skipped.Data->HasField(TEXT("dirty_packages")));
        FString Why;
        Skipped.Data->TryGetStringField(TEXT("dirty_packages_skipped"), Why);
        TestEqual(TEXT("and names the switch"), Why, FString(TEXT("include_dirty")));
    }
    return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
