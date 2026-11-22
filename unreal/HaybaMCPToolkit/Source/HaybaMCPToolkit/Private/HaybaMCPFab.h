#pragma once

#include "IHaybaMCPHandler.h"

namespace HaybaFab
{
    struct FSearchRequest
    {
        FString Source = TEXT("catalog");
        FString Query;
        FString Cursor;
        int32 Limit = 12;
        bool bFreeOnly = false;
    };

    bool ParseSearch(const TSharedPtr<FJsonObject>& Params, FSearchRequest& Out, FString& Error);
    bool IsTrustedListingUrl(const FString& Url);
    // Dispatches Fab's own registered menu action; does not claim the tab loaded.
    bool OpenBrowser(FString& OutError);
    FHaybaHandlerResult Execute(const FString& Command, const TSharedPtr<FJsonObject>& Params, const FString& Owner);
}
