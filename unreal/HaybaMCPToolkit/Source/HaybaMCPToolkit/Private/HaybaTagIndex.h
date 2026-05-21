// HaybaTagIndex.h — Lazy loader for the asset-retriever tag snapshot
// (~/.hayba/cache/retriever-tags.json). Maps UE asset path → tag list.
// Used by the Cognitive Map builder to enrich cells with semantic tags
// when actors carry no UE Tags of their own.

#pragma once

#include "CoreMinimal.h"

class FHaybaTagIndex
{
public:
    /** Path resolution: %USERPROFILE%/.hayba/cache/retriever-tags.json on Windows. */
    static FString DefaultSnapshotPath();

    /** Process-wide instance. Loads on first call; subsequent calls are O(1). */
    static FHaybaTagIndex& Get();

    /** Returns empty list when the asset path is unknown or the snapshot is missing. */
    const TArray<FString>& Lookup(const FString& AssetPath) const;

    /** True iff the snapshot was successfully loaded. */
    bool IsLoaded() const { return bLoaded; }

    /** Drops the cached map and forces a reload on the next Lookup. */
    void Invalidate();

private:
    FHaybaTagIndex() = default;
    void EnsureLoaded();

    mutable bool bLoaded = false;
    mutable bool bLoadAttempted = false;
    mutable TMap<FString, TArray<FString>> PathToTags;
    static const TArray<FString> EmptyTags;
};
