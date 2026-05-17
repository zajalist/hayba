#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"
#include "Input/Reply.h"

class SHaybaMCPMemoryPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPMemoryPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    void SetResults(const TArray<FString>& InEntries);

private:
    TArray<TSharedPtr<FString>> Entries;
    TSharedPtr<SListView<TSharedPtr<FString>>> EntryList;

    FReply OnRefresh();
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FString> Entry, const TSharedRef<STableViewBase>& Owner);
};
