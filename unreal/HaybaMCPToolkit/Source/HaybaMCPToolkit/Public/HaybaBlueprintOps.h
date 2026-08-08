#pragma once

// The blueprint domain's decidable rules, taken out of the editor.
//
// Same split as HaybaActorOps.h and HaybaUIOps.h: the parts that decide things
// are pure and tested here, the parts that touch UBlueprint stay in the handler.
// Both rules below were found by calling the commands against a live editor and
// watching them answer ok for work that had gone wrong. See #320.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPParams.h"

namespace HaybaBlueprintOps
{
    // ── Where a created asset actually lands ─────────────────────────────────

    struct FResolvedPackage
    {
        /** The package that will be created, e.g. /Game/UI/BP_Menu */
        FString PackageName;
        /** The directory the trailing component was stripped to. */
        FString Directory;
        /** True when `package_path`'s last component is NOT the asset name.
         *
         *  The contract is that package_path is the FULL intended asset path and
         *  its trailing component is discarded — so "/Game/Temp" + name "BP_X"
         *  silently produces /Game/BP_X, one directory up from where a caller
         *  reading the parameter name would expect. That happened twice while
         *  writing these descriptions, once leaving an asset at the content
         *  root. The command cannot know which was meant, so it says so. */
        bool bTrailingIsNotName = false;
    };

    /** Compose the package a create command will write to, and notice when the
     *  caller most likely passed a folder. Pure: no packages are touched. */
    FResolvedPackage ResolvePackage(const FString& PackagePath, const FString& AssetName);

    /** The note to attach when the trailing component was not the asset name.
     *  Empty when there is nothing worth saying. */
    FString PackagePathNote(const FResolvedPackage& Resolved, const FString& PackagePath);

    // ── Whether a function name is free ──────────────────────────────────────

    /** An error message if `Requested` collides with an existing graph, empty
     *  otherwise.
     *
     *  blueprint_add_function had no such check. It created a second graph with
     *  the same name, the blueprint stopped compiling with "Found more than one
     *  function with the same name", nothing was rolled back, and the reply was
     *  ok:true carrying compile_errors — verified live. Graph names compare
     *  case-insensitively, because FName does. */
    FString FunctionNameConflict(const TArray<FString>& ExistingGraphNames, const FString& Requested);
}
