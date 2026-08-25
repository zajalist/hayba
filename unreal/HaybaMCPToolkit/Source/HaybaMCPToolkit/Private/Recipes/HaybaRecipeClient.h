// HaybaRecipeClient.h — Thin HTTP client over the MCP server's
// /recipe/run endpoint. Async: caller passes a completion delegate
// fired on the game thread.

#pragma once

#include "CoreMinimal.h"

DECLARE_DELEGATE_TwoParams(FHaybaRecipeRunCallback, bool /*bOk*/, const FString& /*JsonResponseOrError*/);

class FHaybaRecipeClient
{
public:
    /** POST /recipe/run with the given id + params (JSON-serialised). */
    static void RunRecipe(
        const FString& BaseUrl,
        const FString& Id,
        const FString& ParamsJson,
        FHaybaRecipeRunCallback OnDone);
};
