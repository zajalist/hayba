// HaybaRecipeLoader.h — Scans %APPDATA%/Hayba/slivers/*.recipe.json
// (and *.sliver.json, the old name),
// parses each one into FHaybaRecipeSpec, exposes a flat list + lookup.
// Cheap to refresh on demand (no watcher; the panel exposes a Refresh
// button).

#pragma once

#include "CoreMinimal.h"
#include "Recipes/HaybaRecipeTypes.h"

class FHaybaRecipeLoader
{
public:
    /** %APPDATA%/Hayba/recipes on Windows, $HOME/.hayba/Hayba/recipes elsewhere. */
    static FString DefaultUserRecipesDir();

    /** Reads + parses every *.recipe.json (and legacy *.sliver.json) in
     *  UserDir. Replaces in-memory state. */
    void Refresh(const FString& UserDir);

    const TArray<FHaybaRecipeSpec>& List() const { return Specs; }
    const FHaybaRecipeSpec* Find(const FString& Id) const;
    const TArray<FString>& Errors() const { return LoadErrors; }

private:
    TArray<FHaybaRecipeSpec> Specs;
    TArray<FString> LoadErrors;
};
