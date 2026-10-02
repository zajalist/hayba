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
    TestEqual(TEXT("chat and world are the primary destinations"), Destinations.Num(), 2);
    if (Destinations.Num() == 2)
    {
        TestTrue(TEXT("Chat first"), Destinations[0] == EHaybaPanel::Chat);
        TestTrue(TEXT("World second"), Destinations[1] == EHaybaPanel::World);
    }

    for (EHaybaSection Section : { EHaybaSection::Chat, EHaybaSection::MCP,
                                   EHaybaSection::Slivers, EHaybaSection::ToolStream,
                                   EHaybaSection::SceneMap, EHaybaSection::Plan,
                                   EHaybaSection::Diff, EHaybaSection::Validation,
                                   EHaybaSection::Memory, EHaybaSection::Lessons,
                                   EHaybaSection::Settings })
    {
        const EHaybaPanel Owner = SHaybaMCPMainPanel::PanelForSection(Section);
        TestTrue(TEXT("Every retained section stays reachable"),
            SHaybaMCPMainPanel::SectionsFor(Owner).Contains(Section));
    }

    FHaybaMCPStyle::Initialize();
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"));
    TestTrue(TEXT("plugin found"), Plugin.IsValid());
    if (!Plugin.IsValid()) return false;
    for (const TCHAR* Name : { TEXT("Chat"), TEXT("World"), TEXT("More") })
    {
        const FString Key = FString::Printf(TEXT("Hayba.Icon.Nav.%s"), Name);
        TestNotNull(*Key, FHaybaMCPStyle::GetBrush(*Key));
        const FString Stem = FString(Name).ToLower();
        FString Svg;
        const FString Path = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources"), TEXT("Icons"), Stem + TEXT(".svg"));
        TestTrue(*FString::Printf(TEXT("%s SVG exists"), Name), FFileHelper::LoadFileToString(Svg, *Path));
        TestTrue(*FString::Printf(TEXT("%s uses the shared icon grid"), Name), Svg.Contains(TEXT("viewBox=\"0 0 256 256\"")));
        TestFalse(*FString::Printf(TEXT("%s has no old beige fill"), Name), Svg.Contains(TEXT("#FEE7C7")));
        TestFalse(*FString::Printf(TEXT("%s has no baked accent"), Name), Svg.Contains(TEXT("#C47A28")));
    }
    return true;
}
#endif
