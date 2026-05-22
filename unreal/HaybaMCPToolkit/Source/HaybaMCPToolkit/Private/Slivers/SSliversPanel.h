// SSliversPanel.h — Slivers browser: a searchable / filterable table of
// installed slivers on top, the SSliverDetailPanel below. Auto-refreshes
// via a directory watcher; supports import / export / delete.

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverLoader.h"
#include "Slivers/SSliverDetailPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class STableViewBase;
class ITableRow;
struct FFileChangeData;
template <typename T> class SComboBox;

class SSliversPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliversPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual ~SSliversPanel() override;

    /** Re-scan the installed slivers directory and rebuild the table. */
    void Refresh();

private:
    FHaybaSliverLoader Loader;
    TArray<TSharedPtr<FHaybaSliverSpec>> AllItems;       // every loaded sliver
    TArray<TSharedPtr<FHaybaSliverSpec>> FilteredItems;  // after search + category filter

    TSharedPtr<SListView<TSharedPtr<FHaybaSliverSpec>>> ListView;
    TSharedPtr<SSliverDetailPanel> DetailPanel;
    TSharedPtr<FHaybaSliverSpec> Selected;

    FString SearchText;
    FString CategoryFilter;                              // empty = "All"
    TArray<TSharedPtr<FString>> CategoryOptions;
    TSharedPtr<SComboBox<TSharedPtr<FString>>> CategoryCombo;
    TSharedPtr<FString> CategorySelected;

    FString WatchedDir;
    FDelegateHandle WatcherHandle;

    void ApplyFilter();
    void RebuildCategoryOptions();

    TSharedRef<ITableRow> OnGenerateRow(TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner);
    void OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type);

    FReply OnImportClicked();
    FReply OnExportClicked();
    FReply OnDeleteClicked();

    void OnDirectoryChanged(const TArray<FFileChangeData>& Changes);

    /** Conventional on-disk path for a sliver id: <userDir>/<id>.sliver.json */
    FString SliverFilePath(const FString& Id) const;
};
