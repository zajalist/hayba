// Dotted-string tag utilities — the SP-1 stand-in for GameplayTag hierarchy.
// A tag "A.B.C" implicitly provides every ancestor prefix {A, A.B, A.B.C}, so a
// rule on "Style.Imperial" is satisfied by a socket that provides
// "Style.Imperial.Vent". UObject-free so the solver core stays headlessly testable.
#pragma once

#include "CoreMinimal.h"

namespace HaybaTag
{
    // "A.B.C" -> {"A","A.B","A.B.C"}. "" -> {}. Whitespace-tolerant on segments.
    inline TSet<FString> ExpandAncestors(const FString& DottedTag)
    {
        TSet<FString> Out;
        if (DottedTag.IsEmpty())
        {
            return Out;
        }
        TArray<FString> Parts;
        DottedTag.ParseIntoArray(Parts, TEXT("."), /*InCullEmpty=*/true);
        FString Prefix;
        for (const FString& Part : Parts)
        {
            const FString Seg = Part.TrimStartAndEnd();
            if (Seg.IsEmpty()) { continue; }
            Prefix = Prefix.IsEmpty() ? Seg : (Prefix + TEXT(".") + Seg);
            Out.Add(Prefix);
        }
        return Out;
    }

    // Union of ExpandAncestors over a list of provided tags (de-duplicated).
    inline TSet<FString> ExpandAll(const TArray<FString>& Tags)
    {
        TSet<FString> Out;
        for (const FString& T : Tags)
        {
            Out.Append(ExpandAncestors(T));
        }
        return Out;
    }

    // True iff RequiredTag (or, by ancestry, an expanded prefix of a provided tag)
    // is present in the already-expanded provided set.
    inline bool Provides(const TSet<FString>& ExpandedProvides, const FString& RequiredTag)
    {
        return !RequiredTag.IsEmpty() && ExpandedProvides.Contains(RequiredTag);
    }
}
