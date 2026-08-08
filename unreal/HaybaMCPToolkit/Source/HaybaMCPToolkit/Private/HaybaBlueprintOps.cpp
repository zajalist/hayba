#include "HaybaBlueprintOps.h"
#include "Misc/PackageName.h"

namespace HaybaBlueprintOps
{
    FResolvedPackage ResolvePackage(const FString& PackagePath, const FString& AssetName)
    {
        FResolvedPackage Out;
        Out.Directory = FPackageName::GetLongPackagePath(PackagePath);
        Out.PackageName = Out.Directory / AssetName;

        // The component that was thrown away. If it is not the asset name, the
        // caller probably passed a folder and expected the asset inside it.
        FString Trailing = PackagePath;
        int32 Slash = INDEX_NONE;
        if (PackagePath.FindLastChar(TEXT('/'), Slash) && Slash != INDEX_NONE)
        {
            Trailing = PackagePath.Mid(Slash + 1);
        }
        Out.bTrailingIsNotName = !Trailing.IsEmpty() && !Trailing.Equals(AssetName, ESearchCase::IgnoreCase);
        return Out;
    }

    FString PackagePathNote(const FResolvedPackage& Resolved, const FString& PackagePath)
    {
        if (!Resolved.bTrailingIsNotName) return FString();
        return FString::Printf(
            TEXT("'package_path' is the full intended asset path and its last component is discarded, so \"%s\" "
                 "resolved to the folder \"%s\" and the asset was created at \"%s\". If you meant the folder "
                 "\"%s\", pass package_path=\"%s/<name>\"."),
            *PackagePath, *Resolved.Directory, *Resolved.PackageName, *PackagePath, *PackagePath);
    }

    FString FunctionNameConflict(const TArray<FString>& ExistingGraphNames, const FString& Requested)
    {
        for (const FString& Existing : ExistingGraphNames)
        {
            if (Existing.Equals(Requested, ESearchCase::IgnoreCase))
            {
                return FString::Printf(
                    TEXT("blueprint_add_function: '%s' already exists on this blueprint (as '%s'). "
                         "Adding it again compiles to \"Found more than one function with the same name\" and leaves "
                         "the blueprint broken, so nothing was changed. Pick another name, or edit the existing graph."),
                    *Requested, *Existing);
            }
        }
        return FString();
    }
}
