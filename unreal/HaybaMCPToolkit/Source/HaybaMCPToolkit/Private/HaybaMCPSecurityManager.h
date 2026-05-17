#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FHaybaJournalEntry
{
    FDateTime Timestamp;
    FString Command;
    FString ParamsHash;
    int64 DurationMs = 0;
    bool bOk = true;
    FString ErrorMessage;
};

class FHaybaMCPSecurityManager
{
public:
    static FHaybaMCPSecurityManager& Get();

    /**
     * Validate `auth` field on incoming TCP request against configured token.
     * Returns true if auth disabled (empty token) OR token matches.
     * Returns false with OutReason set if missing or mismatched.
     */
    bool ValidateRequest(const TSharedPtr<FJsonObject>& Request, FString& OutReason) const;

    /** Append a journal entry to hayba-execution.log in project Saved dir. Thread-safe. */
    void Journal(const FHaybaJournalEntry& Entry);

    /** Compute SHA-1 hex of params object (deterministic — uses condensed JSON). */
    static FString HashParams(const TSharedPtr<FJsonObject>& Params);

private:
    FHaybaMCPSecurityManager() = default;
    mutable FCriticalSection JournalLock;
};
