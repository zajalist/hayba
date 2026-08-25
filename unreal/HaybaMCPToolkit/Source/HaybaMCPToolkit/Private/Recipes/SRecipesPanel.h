// SRecipesPanel.h — Recipes browser: a searchable / filterable table of
// installed recipes on top, the SRecipeDetailPanel below. Auto-refreshes
// via a directory watcher; supports import / export / delete.

#pragma once

#include "CoreMinimal.h"
#include "Recipes/HaybaRecipeLoader.h"
#include "Recipes/SRecipeDetailPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class STableViewBase;
class ITableRow;
struct FFileChangeData;
template <typename T> class SComboBox;

class SRecipesPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipesPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual ~SRecipesPanel() override;

    /** Re-scan the installed recipes directory and rebuild the table. */
    void Refresh();

private:
    FHaybaRecipeLoader Loader;
    TArray<TSharedPtr<FHaybaRecipeSpec>> AllItems;       // every loaded recipe
    TArray<TSharedPtr<FHaybaRecipeSpec>> FilteredItems;  // after search + category filter

    TSharedPtr<SListView<TSharedPtr<FHaybaRecipeSpec>>> ListView;
    TSharedPtr<SRecipeDetailPanel> DetailPanel;
    TSharedPtr<FHaybaRecipeSpec> Selected;

    FString SearchText;
    FString CategoryFilter;                              // empty = "All"
    TArray<TSharedPtr<FString>> CategoryOptions;
    TSharedPtr<SComboBox<TSharedPtr<FString>>> CategoryCombo;
    TSharedPtr<FString> CategorySelected;

    FString WatchedDir;
    FDelegateHandle WatcherHandle;

    void ApplyFilter();
    void RebuildCategoryOptions();

    TSharedRef<ITableRow> OnGenerateRow(TSharedPtr<FHaybaRecipeSpec> Item, const TSharedRef<STableViewBase>& Owner);
    void OnSelectionChanged(TSharedPtr<FHaybaRecipeSpec> Item, ESelectInfo::Type);

    FReply OnImportClicked();
    FReply OnExportClicked();
    FReply OnDeleteClicked();

    void OnDirectoryChanged(const TArray<FFileChangeData>& Changes);

    /** On-disk path for a recipe id -- whichever spelling exists,
     *  <id>.recipe.json or the older <id>.sliver.json. */
    FString RecipeFilePath(const FString& Id) const;
};
