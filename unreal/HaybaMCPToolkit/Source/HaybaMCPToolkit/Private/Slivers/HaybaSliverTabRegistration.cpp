// HaybaSliverTabRegistration.cpp — Registers the Slivers nomad tab and
// the Window menu entry. Public callable: HaybaSliver_RegisterTab() /
// HaybaSliver_UnregisterTab().

#include "Slivers/SSliversPanel.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"

static const FName SliversTabName(TEXT("HaybaSlivers"));

static TSharedRef<SDockTab> SpawnSliversTab(const FSpawnTabArgs&)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        .Label(NSLOCTEXT("HaybaSlivers", "TabLabel", "Slivers"))
        [
            SNew(SSliversPanel)
        ];
}

void HaybaSliver_RegisterTab()
{
    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(SliversTabName, FOnSpawnTab::CreateStatic(&SpawnSliversTab))
        .SetDisplayName(NSLOCTEXT("HaybaSlivers", "TabTitle", "Slivers"))
        .SetTooltipText(NSLOCTEXT("HaybaSlivers", "TabTooltip", "Hayba Slivers — deterministic abstractions"))
        .SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory());
}

void HaybaSliver_UnregisterTab()
{
    if (FSlateApplication::IsInitialized())
        FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(SliversTabName);
}
