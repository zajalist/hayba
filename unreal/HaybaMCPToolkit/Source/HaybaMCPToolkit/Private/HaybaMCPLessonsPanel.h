#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"
#include "Input/Reply.h"

class ITableRow;
class STableViewBase;

// One accumulated lesson (the [[slug]] knowledge that constraints/validator
// rules cite).
struct FHaybaLessonEntry
{
    FString Slug;
    FString Title;
    FString Body;
    TArray<FString> Refs;
};

// The Memory / Lessons panel — browses .scratch/lessons.json: the durable notes
// explaining WHY constraints exist. Distinct from the Library (which browses
// profiled assets).
class SHaybaLessonsPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaLessonsPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    TArray<TSharedPtr<FHaybaLessonEntry>> Entries;
    TArray<TSharedPtr<FHaybaLessonEntry>> AllEntries;
    TSharedPtr<SListView<TSharedPtr<FHaybaLessonEntry>>> EntryList;
    FString Filter;

    void Reload();
    void ApplyFilter();
    FReply OnRefresh();
    void OnSearchChanged(const FText& Text);
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FHaybaLessonEntry> Entry, const TSharedRef<STableViewBase>& Owner);
};
