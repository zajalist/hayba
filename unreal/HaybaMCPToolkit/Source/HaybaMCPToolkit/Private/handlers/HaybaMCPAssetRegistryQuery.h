#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

namespace HaybaAssetRegistryQuery
{
struct FParams
{
    FString ClassFilter;
    FString NameContains;
    FString PathPrefix;
    bool bRecursive = true;
    int32 Limit = 50;
    int32 Offset = 0;
};

struct FRow
{
    FString Name;
    FString Path;
    FString Class;
};

bool ParseParams(const TSharedPtr<FJsonObject>& Json, FParams& Out, FString& Error);
bool ValidateRegistryRead(bool bSucceeded, FString& Error);
void FilterSortAndPage(const TArray<FRow>& Rows, const FParams& Params,
    TArray<FRow>& Page, int32& Total, bool& bHasMore, int32& NextOffset);
}
