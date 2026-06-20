#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"
#include "Input/Reply.h"

class ITableRow;
class STableViewBase;
class SSearchBox;

// One profiled asset in the Semantic Library.
struct FHaybaLibraryEntry
{
    FString AssetId;
    FString Archetype;
    int32   MaskCount = 0;
    int32   ConstraintCount = 0;
    int32   LockedCount = 0;
};

// The Semantic Library — browses every profiled asset (.scratch/profiles.json +
// constraints.json) and opens any of them in the Semantic Studio.
class SHaybaMCPMemoryPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPMemoryPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Re-read the PLUMB stores from disk and refresh the list. */
    void RefreshLibrary() { Reload(); }

private:
    TArray<TSharedPtr<FHaybaLibraryEntry>> Entries;   // filtered view
    TArray<TSharedPtr<FHaybaLibraryEntry>> AllEntries; // full set
    TSharedPtr<SListView<TSharedPtr<FHaybaLibraryEntry>>> EntryList;
    FString Filter;

    void Reload();
    void ApplyFilter();
    FReply OnRefresh();
    void OnSearchChanged(const FText& Text);
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FHaybaLibraryEntry> Entry, const TSharedRef<STableViewBase>& Owner);
};
