#include "HaybaMCPMemoryPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/SBoxPanel.h"

void SHaybaMCPMemoryPanel::Construct(const FArguments& InArgs)
{
    ChildSlot
    [
        SNew(SVerticalBox)
        + SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right).Padding(8)
        [
            SNew(SButton)
            .Text(NSLOCTEXT("Hayba", "MemRefresh", "Refresh"))
            .OnClicked(this, &SHaybaMCPMemoryPanel::OnRefresh)
        ]
        + SVerticalBox::Slot().FillHeight(1.f)
        [
            SAssignNew(EntryList, SListView<TSharedPtr<FString>>)
            .ListItemsSource(&Entries)
            .OnGenerateRow(this, &SHaybaMCPMemoryPanel::GenerateRow)
        ]
    ];
}

void SHaybaMCPMemoryPanel::SetResults(const TArray<FString>& InEntries)
{
    Entries.Reset();
    for (const auto& E : InEntries) Entries.Add(MakeShared<FString>(E));
    if (EntryList.IsValid()) EntryList->RequestListRefresh();
}

FReply SHaybaMCPMemoryPanel::OnRefresh()
{
    // Placeholder — real refresh fires a TCP memory_query and populates via SetResults.
    return FReply::Handled();
}

TSharedRef<ITableRow> SHaybaMCPMemoryPanel::GenerateRow(TSharedPtr<FString> Entry, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<TSharedPtr<FString>>, Owner)
        [ SNew(STextBlock).AutoWrapText(true).Text(FText::FromString(*Entry)) ];
}
