#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class IHaybaMCPHandler
{
public:
    virtual ~IHaybaMCPHandler() = default;

    /** Domain prefix, e.g. "actor", "scene", "pcg", "legacy". */
    virtual FString GetDomain() const = 0;

    /** All commands this handler dispatches. */
    virtual TArray<FString> GetCommands() const = 0;

    /**
     * Dispatch a command. Returns the FULL response JSON string already
     * formatted with MakeOkResponse / MakeErrorResponse helpers.
     * (Future handlers may return JsonObject + use FHaybaMCPResponseBuilder
     *  for trimming, but the legacy migration preserves FString returns
     *  to avoid behavior changes.)
     */
    virtual FString Handle(const FString& Command,
                           const TSharedPtr<FJsonObject>& Params,
                           const FString& Id) = 0;
};
