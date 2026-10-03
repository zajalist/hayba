#pragma once

#include "CoreMinimal.h"
#include "HaybaMCPWorldTileSnapshot.h"

class UWorld;

/** Game-thread, loaded-editor-world tile capture. A capture never loads cells,
 * opens a tab, renders a viewport, or reads GPU memory. */
namespace HaybaWorldTileCapture
{
constexpr int32 MaxQueuedRequests = 8;
constexpr int32 MaxEligibleActors = 512;
constexpr int32 MaxPointsPerTile = 8192;

enum class EState : uint8
{
    NotCaptured,
    Rejected,
    Queued,
    Scanning,
    Sampling,
    Captured,
    Partial,
    Cancelled,
    Aborted
};

const TCHAR* StateName(EState State);

struct FStatus
{
    EState State = EState::NotCaptured;
    FString TileId;
    FString CaptureId;
    int32 ScannedActorSlots = 0;
    int32 EligibleActorCount = 0;
    int32 ProcessedActorCount = 0;
    int32 PointCount = 0;
    int32 PageCount = 0;
    TArray<FString> Gaps;
    // Only populated after publication; the store owns an immutable snapshot.
    TSharedPtr<const HaybaWorldTileSnapshot::FTile> Snapshot;
};

struct FStartResult
{
    FStatus Status;
    bool bDeduplicated = false;
    FString Error;
};

enum class EEventType : uint8 { Begin, Page, Done };

struct FEvent
{
    EEventType Type = EEventType::Begin;
    FStatus Status;
    // Present for Page; page-local actor and node indices stay intact.
    TSharedPtr<const HaybaWorldTileSnapshot::FPage> Page;
};

DECLARE_MULTICAST_DELEGATE_OneParam(FOnEvent, const FEvent&);

/** Call once from the module lifecycle. Idempotent; every operation requires
 * the game thread. The ticker survives independently of the World panel. */
void Initialize();
void Shutdown();

/** Start a fresh capture. Identical queued/running requests return the same
 * 32-hex capture ID. Bounds are validated through TileBounds, with no clamping. */
FStartResult Start(UWorld* World, int32 LOD, int32 X, int32 Y, int32 Z);
FStartResult StartById(UWorld* World, const FString& TileId);

/** Capture IDs remain queryable after a world switch so aborted work can be
 * diagnosed. Tile IDs address only the supplied current editor world. */
FStatus GetStatus(UWorld* World, const FString& CaptureIdOrTileId);
FStatus Cancel(UWorld* World, const FString& CaptureIdOrTileId);

/** Optional UI observer. Bind with AddSP/CreateSP or another weak binding when
 * the subscriber can close. Callbacks execute synchronously on the game thread.
 * A late subscriber receives the current begin, captured pages, and done state. */
FDelegateHandle Subscribe(const FString& CaptureId, const FOnEvent::FDelegate& Callback);
void Unsubscribe(const FString& CaptureId, FDelegateHandle Handle);
}
