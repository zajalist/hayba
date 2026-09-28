#include "Misc/AutomationTest.h"
#include "HaybaMCPMainPanel.h"
#include "HaybaMCPStyle.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FHaybaWorkspaceNavigationTest, "Hayba.MCP.Workspace.Navigation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaWorkspaceNavigationTest::RunTest(const FString&)
{
    const TArray<EHaybaPanel> Destinations = SHaybaMCPMainPanel::RailDestinations();
    TestEqual(TEXT("three rail destinations"), Destinations.Num(), 3);
    if (Destinations.Num() == 3)
    {
        TestTrue(TEXT("Agent first"), Destinations[0] == EHaybaPanel::Agent);
        TestTrue(TEXT("World second"), Destinations[1] == EHaybaPanel::World);
        TestTrue(TEXT("Library third"), Destinations[2] == EHaybaPanel::Library);
    }
    TestFalse(TEXT("Settings is outside the rail"), Destinations.Contains(EHaybaPanel::Settings));

    FHaybaMCPStyle::Initialize();
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    TestTrue(TEXT("plugin found"), Plugin.IsValid());
    if (!Plugin.IsValid()) return false;
    for (const TCHAR* Name : { TEXT("Agent"), TEXT("World"), TEXT("Library"), TEXT("Settings") })
    {
        const FString Key = FString::Printf(TEXT("Hayba.Icon.%s"), Name);
        TestNotNull(*Key, FHaybaMCPStyle::GetBrush(*Key));
        FString Svg;
        const FString Path = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources"), FString::Printf(TEXT("Icon%s.svg"), Name));
        TestTrue(*FString::Printf(TEXT("%s exists"), Name), FFileHelper::LoadFileToString(Svg, *Path));
        TestTrue(*FString::Printf(TEXT("%s uses 24px grid"), Name), Svg.Contains(TEXT("viewBox=\"0 0 24 24\"")));
        TestFalse(*FString::Printf(TEXT("%s has no old beige fill"), Name), Svg.Contains(TEXT("#FEE7C7")));
        TestFalse(*FString::Printf(TEXT("%s has no baked accent"), Name), Svg.Contains(TEXT("#C47A28")));
    }
    return true;
}
#endif
