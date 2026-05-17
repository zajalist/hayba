// Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSceneMapWebPanel.h
//
// CEF/D3-based renderer for the cognitive map (spec §3.2). Hosts an
// SWebBrowser loading cognitive-map/index.html bundled with the plugin and
// pushes the FHaybaCogMapCell list as JSON via ExecuteJavascript.
//
// Falls back to a "WebBrowser not available" message when the WebBrowser
// module isn't initialized (e.g. headless editor / commandlet).
#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "HaybaMCPSceneMapData.h"

class SWebBrowser;

class SHaybaMCPSceneMapWebPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPSceneMapWebPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Re-scan and re-render. */
    void Refresh();
    void FitView();
    void ResetView();
    int32 GetCellCount() const { return Cells.Num(); }

private:
    TArray<FHaybaCogMapCell> Cells;
    TSharedPtr<SWebBrowser>  Browser;
    bool                     bPageLoaded = false;

    FString ResolveHtmlUrl() const;
    FString CellsToJson() const;

    void OnPageLoaded();
    void PushCellsToPage();
    void Run(const FString& Js);
};
