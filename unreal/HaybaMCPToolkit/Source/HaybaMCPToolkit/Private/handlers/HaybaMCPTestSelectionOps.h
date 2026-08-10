#pragma once

#include "CoreMinimal.h"

namespace HaybaTestSelection
{
    inline bool Matches(
        const FString& DisplayName,
        const FString& FullPath,
        const FString& FilterPattern,
        const FString& CategoryFilter)
    {
        if (!FilterPattern.IsEmpty()
            && !DisplayName.Contains(FilterPattern, ESearchCase::IgnoreCase)
            && !FullPath.Contains(FilterPattern, ESearchCase::IgnoreCase))
        {
            return false;
        }
        return CategoryFilter.IsEmpty()
            || FullPath.StartsWith(CategoryFilter, ESearchCase::IgnoreCase);
    }

    inline FString ValidateCombination(
        const bool bRunAll,
        const int32 ExplicitNameCount,
        const bool bHasSelector)
    {
        if (bRunAll && ExplicitNameCount > 0)
        {
            return TEXT("test_run cannot combine 'all' with explicit test names");
        }
        if (bHasSelector && ExplicitNameCount > 0)
        {
            return TEXT("test_run cannot combine filter/category selectors with explicit test_names; "
                        "use selectors alone, or use test_names alone");
        }
        return FString();
    }

    inline FString ValidateResolvedSelection(
        const bool bRunAll,
        const bool bHasSelector,
        const int32 SelectedCount)
    {
        if (SelectedCount > 0) return FString();
        if (!bRunAll && !bHasSelector)
        {
            return TEXT("test_run requires test_names, 'all', filter/filter_pattern, or category");
        }
        return TEXT("test_run matched no tests");
    }
}
