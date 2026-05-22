// SSliversPanel.h — Top-level Slate panel: list of installed slivers
// on the left, SSliverDetailPanel on the right.

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverLoader.h"
#include "Slivers/SSliverDetailPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class SSliversPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SSliversPanel) {}
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);

    /** Re-scan the installed slivers directory and rebuild the list. */
    void Refresh();

private:
    FHaybaSliverLoader Loader;
    TArray<TSharedPtr<FHaybaSliverSpec>> ListItems;
    TSharedPtr<SListView<TSharedPtr<FHaybaSliverSpec>>> ListView;
    TSharedPtr<SSliverDetailPanel> DetailPanel;

    FReply OnRefreshClicked() { Refresh(); return FReply::Handled(); }
    TSharedRef<ITableRow> OnGenerateRow(TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner);
    void OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type);
};
