#pragma once
#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class SVerticalBox;
class SScrollBox;
class SSearchBox;

struct FHaybaDiffEntry
{
    FString ActorLabel;
    FString ActorClass;       // optional — for type chip
    FString Property;
    FString Before;
    FString After;
    FString LevelPackage;     // optional — used for source control lookup
    FDateTime Timestamp = FDateTime::Now();
    bool bAccepted = false;
    bool bReverted = false;
};

/**
 * Diff panel — surfaces every destructive AI mutation as a reviewable
 * Before / After change. Grouped per-actor, with source control integration
 * (Git / Perforce / SVN) so the AI's edits go through the same check-out /
 * submit flow as a human's.
 */
class SHaybaMCPDiffPanel : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SHaybaMCPDiffPanel) {}
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

    void AddEntry(const FHaybaDiffEntry& Entry);
    void Clear();
    int32 GetEntryCount() const { return Entries.Num(); }

private:
    TArray<TSharedPtr<FHaybaDiffEntry>> Entries;
    FString FilterQuery;

    TSharedPtr<SVerticalBox> ListContainer;
    TSharedPtr<SSearchBox>   Search;

    TSharedRef<SWidget> BuildToolbar();
    TSharedRef<SWidget> BuildHeader();
    TSharedRef<SWidget> BuildActorCard(const FString& ActorLabel, const TArray<int32>& EntryIndices);
    TSharedRef<SWidget> BuildEntryRow(int32 EntryIndex);
    TSharedRef<SWidget> BuildFooter();
    TSharedRef<SWidget> BuildSourceControlBadge(const FString& LevelPackage) const;
    void RebuildList();

    void OnSearchChanged(const FText& InText);
    FReply OnAcceptEntry(int32 Index);
    FReply OnRevertEntry(int32 Index);
    FReply OnCheckOutAll();
    FReply OnRevertAll();
    FReply OnSubmit();

    bool   IsSourceControlEnabled() const;
    FString SourceControlProviderName() const;

    // Group entries by ActorLabel for the card-based render.
    TMap<FString, TArray<int32>> GroupByActor() const;
};
