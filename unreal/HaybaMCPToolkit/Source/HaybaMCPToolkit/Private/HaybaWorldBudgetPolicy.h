#pragma once

#include "CoreMinimal.h"

namespace HaybaWorldBudget
{
    inline constexpr int32 MaxScannedActors = 200000;
    inline constexpr int32 MaxRows = 50;

    inline int32 BoundedRowCount(int32 Total) { return FMath::Min(MaxRows, Total); }
    inline bool RowsTruncated(int32 Total) { return Total > MaxRows; }

    inline FString NormalizeFolder(FString Folder)
    {
        Folder.ReplaceInline(TEXT("\\"), TEXT("/"));
        Folder.TrimStartAndEndInline();
        while (Folder.RemoveFromStart(TEXT("/"))) {}
        while (Folder.RemoveFromEnd(TEXT("/"))) {}
        while (Folder.Contains(TEXT("//"))) Folder.ReplaceInline(TEXT("//"), TEXT("/"));
        return Folder;
    }

    inline bool ContainsFolder(const FString& Parent, const FString& Child)
    {
        return Parent.IsEmpty() || Child == Parent || Child.StartsWith(Parent + TEXT("/"));
    }

    inline void AddFolderCounts(const FString& Folder, TMap<FString, int32>& Direct,
                                TMap<FString, int32>& Descendants)
    {
        Direct.FindOrAdd(Folder)++;
        Descendants.FindOrAdd(TEXT(""))++;
        FString Ancestor = Folder;
        while (!Ancestor.IsEmpty())
        {
            Descendants.FindOrAdd(Ancestor)++;
            int32 Slash = INDEX_NONE;
            if (!Ancestor.FindLastChar(TEXT('/'), Slash)) break;
            Ancestor.LeftInline(Slash);
        }
    }

    inline const TCHAR* StructuralTargetVerdict(bool bComplete, double Observed, double Maximum)
    {
        if (!bComplete) return TEXT("unknown_incomplete_scan");
        return Observed > Maximum ? TEXT("exceeds_user_structural_limit")
            : TEXT("within_user_structural_limit_for_loaded_scope");
    }
}
