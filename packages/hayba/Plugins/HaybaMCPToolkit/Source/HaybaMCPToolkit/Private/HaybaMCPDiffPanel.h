#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

struct FHaybaDiffEntry
{
    FString ActorLabel;
    FString Property;
    FString Before;
    FString After;
};

class SHaybaMCPDiffPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPDiffPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);
    void AddEntry(const FHaybaDiffEntry& Entry);
    void Clear();

private:
    TArray<TSharedPtr<FHaybaDiffEntry>> Entries;
    TSharedPtr<SListView<TSharedPtr<FHaybaDiffEntry>>> EntryList;
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FHaybaDiffEntry> E, const TSharedRef<STableViewBase>& Owner);
};
