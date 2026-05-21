// HaybaSliverClient.h — Thin HTTP client over the MCP server's
// /sliver/run endpoint. Async: caller passes a completion delegate
// fired on the game thread.

#pragma once

#include "CoreMinimal.h"

DECLARE_DELEGATE_TwoParams(FHaybaSliverRunCallback, bool /*bOk*/, const FString& /*JsonResponseOrError*/);

class FHaybaSliverClient
{
public:
    /** POST /sliver/run with the given id + params (JSON-serialised). */
    static void RunSliver(
        const FString& BaseUrl,
        const FString& Id,
        const FString& ParamsJson,
        FHaybaSliverRunCallback OnDone);
};
