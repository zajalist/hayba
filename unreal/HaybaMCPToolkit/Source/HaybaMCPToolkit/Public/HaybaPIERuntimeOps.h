#pragma once

// Typed, pure request parsing and PIE-world selection for the runtime
// inspection tools. Keeping these decisions out of the handler makes the
// hostile-wire and multi-client cases testable without starting PIE.

#include "CoreMinimal.h"
#include "Engine/EngineTypes.h"
#include "HaybaMCPParams.h"

namespace HaybaPIERuntimeOps
{
    // FHaybaMCPResponseLimits caps every JSON array at 50. A larger tool page
    // would be truncated after the handler computed returned/next_offset,
    // making those fields lie. Keep page caps at the actual wire ceiling.
    constexpr int32 MaxListLimit = 50;
    constexpr int32 MaxComponents = 50;
    constexpr int32 MaxRetainedActorMatches = 10000;
    constexpr int32 MaxListOffset = MaxRetainedActorMatches - 1;
    constexpr int32 MaxComponentOffset = 1000000;
    constexpr int32 MaxFilterLength = 256;
    constexpr int32 MaxReferenceLength = 2048;
    // Centimetres. Large enough for large-world maps, small enough that view
    // projection and JSON serialization remain finite and standards-compliant.
    constexpr double MaxWorldCoordinateAbs = 1000000000.0;

    struct FWorldSelector
    {
        TOptional<int32> PIEInstance;
    };

    struct FListRequest
    {
        FWorldSelector World;
        FString ClassFilter;
        FString NameFilter;
        FString Tag;
        int32 Offset = 0;
        int32 Limit = 50;
    };

    struct FActorReference
    {
        FString Path;
        FString Id;
        FString Label;

        int32 SuppliedCount() const
        {
            return (!Path.IsEmpty() ? 1 : 0) + (!Id.IsEmpty() ? 1 : 0) + (!Label.IsEmpty() ? 1 : 0);
        }
    };

    struct FInspectRequest
    {
        FWorldSelector World;
        FActorReference Actor;
        FString ComponentFilter;
        int32 ComponentOffset = 0;
        int32 ComponentLimit = 50;
    };

    struct FProjectRequest
    {
        FWorldSelector World;
        FActorReference Actor;
        TOptional<FVector> WorldLocation;
        FString ComponentName;
        FString Sample = TEXT("bounds_origin");
        int32 PlayerIndex = 0;
        bool bTraceVisibility = true;
    };

    struct FActorInteractionRequest
    {
        FProjectRequest Projection;
        FString Action = TEXT("click");
    };

    struct FWorldCandidate
    {
        int32 PIEInstance = INDEX_NONE;
        FString WorldName;
        bool bIsPlayWorld = false;
        bool bHasViewport = false;
    };

    struct FWorldSelection
    {
        int32 CandidateIndex = INDEX_NONE;
        FString Reason;
        FString Error;
        bool bWasAmbiguous = false;

        bool IsValid() const { return CandidateIndex != INDEX_NONE && Error.IsEmpty(); }
    };

    struct FPageWindow
    {
        int32 Start = 0;
        int32 End = 0;
        bool bHasMore = false;
        TOptional<int32> NextOffset;
    };

    FListRequest ParseList(FHaybaParamReader& R);
    FInspectRequest ParseInspect(FHaybaParamReader& R);
    FProjectRequest ParseProject(FHaybaParamReader& R);
    FActorInteractionRequest ParseActorInteraction(FHaybaParamReader& R);

    /**
     * Stable selection for 0/1/multi-client PIE.
     *
     * Explicit PIE instance always wins. Without one, a single candidate wins,
     * then the unique candidate that owns a viewport, then the active PlayWorld.
     * Multiple viewport candidates are rejected: selecting the wrong client and
     * returning plausible coordinates is worse than requiring one integer.
     */
    FWorldSelection SelectWorld(
        const TArray<FWorldCandidate>& Candidates,
        const TOptional<int32>& RequestedPIEInstance,
        bool bRequireViewport);

    FPageWindow ComputePage(int32 Offset, int32 Limit, int32 RetainedCount);
    bool IsFiniteVector(const FVector& Value);
    bool IsFiniteRotator(const FRotator& Value);
    FString CollisionEnabledName(ECollisionEnabled::Type Value);
}
