#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/STreeView.h"
#include "Input/Reply.h"

class ITableRow;
class STableViewBase;
template<typename T> class SComboBox;

// One profiled asset in the Semantic Library.
struct FHaybaLibraryEntry
{
    FString AssetId;
    FString Archetype;
    int32   MaskCount = 0;
    int32   ConstraintCount = 0;
    int32   LockedCount = 0;
};

// A node in the library tree: either a folder (path segment, has children) or a
// leaf asset (carries the entry).
struct FHaybaLibraryNode
{
    FString Name;                                  // folder segment, or asset short name
    bool    bFolder = false;
    TSharedPtr<FHaybaLibraryEntry> Asset;          // leaf only
    TArray<TSharedPtr<FHaybaLibraryNode>> Children;
};

// The Semantic Library — browses every profiled asset as a folder tree (by
// /Game path), with multi-select + bulk maintenance actions.
class SHaybaMCPMemoryPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPMemoryPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    /** Re-read the PLUMB stores from disk and rebuild the tree. */
    void RefreshLibrary() { Reload(); }

private:
    TArray<TSharedPtr<FHaybaLibraryNode>> RootNodes;
    TArray<TSharedPtr<FHaybaLibraryEntry>> AllEntries;
    TSet<FString> Checked;                          // checked asset ids
    TSharedPtr<STreeView<TSharedPtr<FHaybaLibraryNode>>> Tree;
    FString Filter;

    // Bulk-action primitive selection.
    TArray<TSharedPtr<FString>> PrimitiveOptions;
    TSharedPtr<FString> SelectedPrimitive;

    void Reload();
    void RebuildTree();
    FReply OnRefresh();
    void OnSearchChanged(const FText& Text);
    void GetChildren(TSharedPtr<FHaybaLibraryNode> Node, TArray<TSharedPtr<FHaybaLibraryNode>>& Out);
    TSharedRef<ITableRow> GenerateRow(TSharedPtr<FHaybaLibraryNode> Node, const TSharedRef<STableViewBase>& Owner);

    // Bulk actions over the checked set.
    FReply OnApplyTemplate();
    FReply OnRemoveChecked();
    FReply OnCheckAll();
    FReply OnCheckNone();
    void CollectAssets(const TSharedPtr<FHaybaLibraryNode>& Node, TArray<FString>& Out) const;
};
