#pragma once

#include "CoreMinimal.h"
#include "Interfaces/IHttpRequest.h"

enum class EHaybaMCPModelDiscoveryStatus : uint8
{
    Ok,
    Partial,
    NoKey,
    Manual,
    Unavailable,
    Error
};

enum class EHaybaMCPModelChatCapability : uint8 { Unknown, Yes, No };
enum class EHaybaMCPModelToolUse : uint8 { Unknown, Yes, No, Conditional, Trained };

struct FHaybaMCPDiscoveredModel
{
    // Preserve the provider's exact identifier; do not turn the display name
    // into a model id or normalize its case.
    FString Id;
    FString Name;
    EHaybaMCPModelChatCapability ChatCapability = EHaybaMCPModelChatCapability::Unknown;
    EHaybaMCPModelToolUse ToolUse = EHaybaMCPModelToolUse::Unknown;
    TArray<FString> ReasoningEfforts;
};

struct FHaybaMCPModelDiscoveryResult
{
    FString Provider;
    EHaybaMCPModelDiscoveryStatus Status = EHaybaMCPModelDiscoveryStatus::Error;
    TArray<FHaybaMCPDiscoveredModel> Models;
    FString ConfiguredModel;
    FString DefaultModel;
    FString FetchedAt;
    FString Reason;
    FString Note;
    FString Error;
    bool bStale = false;
    bool bCached = false;
    bool bPartial = false;
    bool bManualEntryAllowed = true;
};

/**
 * Discover models for the SAVED Settings configuration. Hold this client for
 * as long as the Settings panel is open. Each attempt uses a fresh temporary
 * sidecar session. DiscoverSavedSettings cancels the preceding request; Cancel
 * (also called by the destructor) drops its callback and queues config removal.
 * Call Cancel when an unsaved provider, endpoint, or key edit invalidates the
 * result currently being displayed.
 */
class FHaybaMCPModelDiscoveryClient : public TSharedFromThis<FHaybaMCPModelDiscoveryClient>
{
public:
    using FCompletion = TFunction<void(FHaybaMCPModelDiscoveryResult)>;

    FHaybaMCPModelDiscoveryClient();
    ~FHaybaMCPModelDiscoveryClient();

    void DiscoverSavedSettings(bool bRefresh, FCompletion OnComplete);
    void Cancel();

    /** Accept only the local sidecar; canonicalize localhost to numeric loopback. */
    static bool TryCanonicalLoopbackBase(const FString& SidecarURL, FString& OutBase);

    /** Parse only the documented discovery fields, preserving exact model IDs. */
    static bool TryParseModels(const FString& Json, const FString& ExpectedProvider,
        FHaybaMCPModelDiscoveryResult& OutResult);

private:
    FString SessionId;
    FString BaseURL;
    FString RequestedProvider;
    uint64 Generation = 0;
    TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> ActiveRequest;
    FCompletion Completion;

    void StartModelsGet(uint64 RequestGeneration, bool bRefresh);
    void Finish(uint64 RequestGeneration, FHaybaMCPModelDiscoveryResult Result);
};
