// HaybaSliverLoader.h — Scans %APPDATA%/Hayba/slivers/*.sliver.json,
// parses each one into FHaybaSliverSpec, exposes a flat list + lookup.
// Cheap to refresh on demand (no watcher; the panel exposes a Refresh
// button).

#pragma once

#include "CoreMinimal.h"
#include "Slivers/HaybaSliverTypes.h"

class FHaybaSliverLoader
{
public:
    /** %APPDATA%/Hayba/slivers on Windows, $HOME/.hayba/Hayba/slivers elsewhere. */
    static FString DefaultUserSliversDir();

    /** Reads + parses every *.sliver.json in UserDir. Replaces in-memory state. */
    void Refresh(const FString& UserDir);

    const TArray<FHaybaSliverSpec>& List() const { return Specs; }
    const FHaybaSliverSpec* Find(const FString& Id) const;
    const TArray<FString>& Errors() const { return LoadErrors; }

private:
    TArray<FHaybaSliverSpec> Specs;
    TArray<FString> LoadErrors;
};
