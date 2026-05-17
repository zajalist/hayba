// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCapabilitiesPanel.h
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Input/Reply.h"

class FHaybaMCPModule;
class SVerticalBox;
class SScrollBox;

/**
 * MCP capabilities panel — lets the user pick which tools are advertised to
 * the remote agent. Disabled tools are filtered out of list_tool_categories
 * and get_tool_signature on the Node MCP side, and rejected with a
 * `tool_disabled` error if called directly.
 *
 * Backed by FHaybaMCPSettings::DisabledTools. Mirrored to
 * Saved/HaybaMCP/disabled-tools.json on every save; the Node server watches
 * that file and rebuilds its disabled set when it changes.
 */
class SHaybaMCPCapabilitiesPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPCapabilitiesPanel) {}
        SLATE_ARGUMENT(FHaybaMCPModule*, Module)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    FHaybaMCPModule* Module = nullptr;

    struct FToolEntry
    {
        FString Name;
        FString Description;
    };
    struct FCategoryEntry
    {
        FText Title;
        FString Description;
        TArray<FToolEntry> Tools;
        bool bExpanded = false;
    };

    TArray<FCategoryEntry> Categories;
    FString FilterQuery;
    TSharedPtr<SVerticalBox> CategoryList;

    void BuildCatalog();
    void RebuildCategoryList();
    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildStatusStrip();
    TSharedRef<SWidget> BuildToolbar();
    TSharedRef<SWidget> BuildCategoryRow(int32 CategoryIndex);
    TSharedRef<SWidget> BuildToolRow(int32 CategoryIndex, int32 ToolIndex);

    // Selection helpers — drive checkbox state and toolbar counters.
    int32  EnabledCountInCategory(const FCategoryEntry& Cat) const;
    int32  TotalToolsInCategory(const FCategoryEntry& Cat) const;
    bool   IsToolEnabled(const FString& ToolName) const;
    void   SetToolEnabled(const FString& ToolName, bool bEnabled);
    void   SetCategoryEnabled(const FCategoryEntry& Cat, bool bEnabled);
    int32  TotalEnabledTools() const;
    int32  TotalTools() const;

    // Toolbar handlers.
    void   OnSearchChanged(const FText& InText);
    FReply OnEnableAll();
    FReply OnDisableAll();
    void   PersistAndNotify();

    bool   CategoryMatchesFilter(const FCategoryEntry& Cat) const;
    bool   ToolMatchesFilter(const FToolEntry& Tool) const;
};
