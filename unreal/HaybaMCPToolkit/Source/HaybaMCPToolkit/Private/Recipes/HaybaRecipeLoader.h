// HaybaRecipeLoader.h — Scans %APPDATA%/Hayba/recipes/*.recipe.json
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

    /** Where the library lived before the rename. */
    static FString LegacyUserRecipesDir();

    /** Move a pre-rename library to its new home, once. Safe to race with the
     *  MCP server doing the same. Returns true if anything moved. */
    static bool MigrateLegacyLibrary(const FString& LegacyDir, const FString& UserDir);

    /** True for either spec spelling. */
    static bool IsRecipeSpecFile(const FString& Name);

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
