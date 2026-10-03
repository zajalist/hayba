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

    for (EHaybaSection Section : { EHaybaSection::Chat,
                                   EHaybaSection::Slivers, EHaybaSection::ToolStream,
                                   EHaybaSection::SceneMap,
                                   EHaybaSection::Diff, EHaybaSection::Validation,
                                   EHaybaSection::Memory,
                                   EHaybaSection::Settings })
    {
        const EHaybaPanel Owner = SHaybaMCPMainPanel::PanelForSection(Section);
        TestTrue(TEXT("Every retained section stays reachable"),
            SHaybaMCPMainPanel::SectionsFor(Owner).Contains(Section));
    }
    TestFalse(TEXT("unused Plan page is absent from Activity tabs"),
        SHaybaMCPMainPanel::SectionsFor(EHaybaPanel::Activity).Contains(EHaybaSection::Plan));
    TestFalse(TEXT("unused Lessons page is absent from Checks tabs"),
        SHaybaMCPMainPanel::SectionsFor(EHaybaPanel::Rules).Contains(EHaybaSection::Lessons));
    TestTrue(TEXT("legacy Plan deep link retains its Activity owner"),
        SHaybaMCPMainPanel::PanelForSection(EHaybaSection::Plan) == EHaybaPanel::Activity);
    const TArray<EHaybaSection> SettingsSections = SHaybaMCPMainPanel::SectionsFor(EHaybaPanel::Settings);
    TestTrue(TEXT("Settings opens as one view"),
        SettingsSections.Num() == 1 && SettingsSections[0] == EHaybaSection::Settings);
    TestTrue(TEXT("tool permissions deep link retains its Settings owner"),
        SHaybaMCPMainPanel::PanelForSection(EHaybaSection::MCP) == EHaybaPanel::Settings);

    FHaybaMCPStyle::Initialize();

    // The settings view stays cached when its advanced permission controls are
    // opened, so fields awaiting Save survive the round trip.
    TSharedRef<SHaybaMCPMainPanel> MainPanel = SNew(SHaybaMCPMainPanel, nullptr);
    MainPanel->ShowPanel(EHaybaPanel::Settings);
    const TSharedRef<SWidget>* CachedSettings = MainPanel->PanelCache.Find(EHaybaSection::Settings);
    TestTrue(TEXT("Settings view is cached"), CachedSettings != nullptr);
    if (CachedSettings)
    {
        // Copy the ref before another TMap insertion can invalidate Find's pointer.
        const TSharedRef<SWidget> CachedSettingsWidget = *CachedSettings;
        MainPanel->ShowSection(EHaybaSection::MCP);
        TestTrue(TEXT("tool permissions opens under Settings"),
            MainPanel->CurrentPanel == EHaybaPanel::Settings && MainPanel->CurrentSection == EHaybaSection::MCP);
        MainPanel->ShowPanel(EHaybaPanel::Settings);
        TestTrue(TEXT("Settings returns from tool permissions"),
            MainPanel->CurrentSection == EHaybaSection::Settings);
        const TSharedRef<SWidget>* ReturnedSettings = MainPanel->PanelCache.Find(EHaybaSection::Settings);
        TestTrue(TEXT("Settings form is reused after tool permissions"),
            ReturnedSettings && *ReturnedSettings == CachedSettingsWidget);

        MainPanel->ShowOnboardingFromSplash();
        TestTrue(TEXT("onboarding temporarily replaces Settings"), MainPanel->bShowingOnboarding);
        MainPanel->ShowPanel(EHaybaPanel::Settings);
        TestTrue(TEXT("Settings can reopen after onboarding"),
            MainPanel->CurrentSection == EHaybaSection::Settings && !MainPanel->bShowingOnboarding);
    }

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
