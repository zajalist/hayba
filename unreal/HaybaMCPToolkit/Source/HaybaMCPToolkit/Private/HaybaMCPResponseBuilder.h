#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaResponseLimits
{
    int32 MaxArrayItems = 50;
    int32 MaxStringChars = 512;
    int32 MaxTopLevelFields = 20;
};

class FHaybaMCPResponseBuilder
{
public:
    explicit FHaybaMCPResponseBuilder(const FHaybaResponseLimits& InLimits = FHaybaResponseLimits());

    /** Trim string in place, returning whether trimmed. */
    bool TrimString(FString& InOutValue) const;

    /** Trim array in place, returning number of items removed. */
    int32 TrimArray(TArray<TSharedPtr<FJsonValue>>& InOutItems) const;

    /** Recursively walk and trim a JSON object, marking truncations under `_truncated`. */
    TSharedRef<FJsonObject> Build(const TSharedRef<FJsonObject>& Source) const;

    /** Convenience: serialize to compact string. */
    FString Serialize(const TSharedRef<FJsonObject>& Source) const;

private:
    FHaybaResponseLimits Limits;
};
