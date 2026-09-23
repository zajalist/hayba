#include "Misc/AutomationTest.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaAgentAffordanceTest, "Hayba.MCP.Agent.Affordances",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaAgentAffordanceTest::RunTest(const FString&)
{
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    TestTrue(TEXT("Hayba plugin found"), Plugin.IsValid());
    if (!Plugin.IsValid()) return false;

    FString Source;
    const FString Path = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp"));
    TestTrue(TEXT("chat source available in the test host"), FFileHelper::LoadFileToString(Source, *Path));
    if (Source.IsEmpty()) return false;

    const int32 RowStart = Source.Find(TEXT("SHaybaMCPChatPanel::BuildMessageRow("));
    const int32 CardStart = Source.Find(TEXT("SHaybaMCPChatPanel::BuildActivityCard("));
    TestTrue(TEXT("message row and activity card found"), RowStart != INDEX_NONE && CardStart > RowStart);
    if (RowStart == INDEX_NONE || CardStart <= RowStart) return false;

    const FString Row = Source.Mid(RowStart, CardStart - RowStart);
    TestFalse(TEXT("no placeholder preview button"), Row.Contains(TEXT("PreviewBtn")));
    TestFalse(TEXT("no unbound graph creation button"), Row.Contains(TEXT("CreateBtn")));
    TestFalse(TEXT("no unbound graph test button"), Row.Contains(TEXT("TestBtn")));
    TestTrue(TEXT("real activity cards still appear in messages"), Row.Contains(TEXT("BuildActivityCard(Msg.ActivityId)")));
    return true;
}
#endif
