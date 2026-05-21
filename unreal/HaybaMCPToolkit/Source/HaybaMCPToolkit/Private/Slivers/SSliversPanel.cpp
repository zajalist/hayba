// SSliversPanel.cpp
#include "Slivers/SSliversPanel.h"

#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/STableRow.h"

void SSliversPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().Padding(4)
        [
            SNew(SHorizontalBox)
            + SHorizontalBox::Slot().AutoWidth().Padding(2)
            [
                SNew(SButton)
                .Text(FText::FromString(TEXT("Refresh")))
                .OnClicked(this, &SSliversPanel::OnRefreshClicked)
            ]
            + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center).Padding(8, 0)
            [
                SNew(STextBlock).Text(FText::FromString(TEXT("Slivers (deterministic abstractions)")))
            ]
        ]
        + SVerticalBox::Slot().FillHeight(1.0f)
        [
            SNew(SSplitter)
            + SSplitter::Slot().Value(0.3f)
            [
                SAssignNew(ListView, SListView<TSharedPtr<FHaybaSliverSpec>>)
                .ListItemsSource(&ListItems)
                .OnGenerateRow(this, &SSliversPanel::OnGenerateRow)
                .OnSelectionChanged(this, &SSliversPanel::OnSelectionChanged)
                .SelectionMode(ESelectionMode::Single)
            ]
            + SSplitter::Slot().Value(0.7f)
            [
                SAssignNew(DetailPanel, SSliverDetailPanel)
            ]
        ]
    ];

    Refresh();
}

void SSliversPanel::Refresh()
{
    Loader.Refresh(FHaybaSliverLoader::DefaultUserSliversDir());
    ListItems.Reset();
    for (const FHaybaSliverSpec& S : Loader.List())
        ListItems.Add(MakeShared<FHaybaSliverSpec>(S));
    if (ListView) ListView->RequestListRefresh();
}

TSharedRef<ITableRow> SSliversPanel::OnGenerateRow(TSharedPtr<FHaybaSliverSpec> Item, const TSharedRef<STableViewBase>& Owner)
{
    const FString DisplayText = Item.IsValid()
        ? FString::Printf(TEXT("%s   [%s]"), *Item->Title, *Item->Category)
        : FString();
    return SNew(STableRow<TSharedPtr<FHaybaSliverSpec>>, Owner)
        [ SNew(STextBlock).Text(FText::FromString(DisplayText)) ];
}

void SSliversPanel::OnSelectionChanged(TSharedPtr<FHaybaSliverSpec> Item, ESelectInfo::Type)
{
    if (Item.IsValid() && DetailPanel) DetailPanel->SetSpec(*Item);
}
