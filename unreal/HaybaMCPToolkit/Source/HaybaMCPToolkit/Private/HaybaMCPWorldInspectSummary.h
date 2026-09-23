#pragma once

#include "CoreMinimal.h"

class FJsonObject;

/** Factual, loaded-world-only result for the Agent dock. */
struct FHaybaWorldInspectSummary
{
    bool bSuccess = false;
    FString LevelPackage;
    FString CurrentLevelPackage;
    bool bPartitionEnabled = false;
    int32 LoadedLandscapeCount = 0;
    bool bSaveReady = false;
    FString Error;

    static FHaybaWorldInspectSummary FromResponse(bool bOk, const TSharedPtr<FJsonObject>& Data);
    FString ToConversationText() const;
};

/** Reject callbacks from a previous inspection or conversation. */
class FHaybaInspectRequestGeneration
{
public:
    uint64 Begin() { return ++Current; }
    void Invalidate() { ++Current; }
    bool IsCurrent(uint64 Generation) const { return Generation != 0 && Generation == Current; }

private:
    uint64 Current = 0;
};
