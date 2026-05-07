#include "HaybaMCPDiffPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/SBoxPanel.h"

void SHaybaMCPDiffPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SAssignNew(EntryList, SListView<TSharedPtr<FHaybaDiffEntry>>)
        .ListItemsSource(&Entries)
        .OnGenerateRow(this, &SHaybaMCPDiffPanel::GenerateRow)
    ];
}

void SHaybaMCPDiffPanel::AddEntry(const FHaybaDiffEntry& Entry)
{
    Entries.Add(MakeShared<FHaybaDiffEntry>(Entry));
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

void SHaybaMCPDiffPanel::Clear()
{
    Entries.Reset();
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

TSharedRef<ITableRow> SHaybaMCPDiffPanel::GenerateRow(TSharedPtr<FHaybaDiffEntry> E, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FHaybaDiffEntry>>, Owner)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(0.25f).Padding(4)
        [ SNew(STextBlock).Text(FText::FromString(FString::Printf(TEXT("%s.%s"), *E->ActorLabel, *E->Property))) ]
        + SHorizontalBox::Slot().FillWidth(0.375f).Padding(4)
        [ SNew(STextBlock).ColorAndOpacity(FSlateColor(FLinearColor(0.9f, 0.4f, 0.4f))).Text(FText::FromString(E->Before)) ]
        + SHorizontalBox::Slot().FillWidth(0.375f).Padding(4)
        [ SNew(STextBlock).ColorAndOpacity(FSlateColor(FLinearColor(0.4f, 0.9f, 0.4f))).Text(FText::FromString(E->After)) ]
    ];
}
