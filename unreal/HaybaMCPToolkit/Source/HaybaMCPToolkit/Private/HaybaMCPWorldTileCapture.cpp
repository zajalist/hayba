#include "HaybaMCPWorldTileCapture.h"

#include "HaybaMCPEditorHealth.h"
#include "HaybaMCPWorldGeometry.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Containers/Ticker.h"
#include "Editor.h"
#include "Engine/Level.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformTime.h"
#include "LandscapeComponent.h"
#include "Misc/DateTime.h"
#include "Misc/Guid.h"
#include "String/LexFromString.h"

namespace HaybaWorldTileCapture
{
namespace
{
constexpr int32 MaxRetainedJobs = 32;
constexpr int32 MaxScannedActorSlots = 32768;
constexpr int32 ScanSlotsPerTick = 256;
constexpr int32 MaxEligibilityComponentsPerActor = 64;
constexpr double SoftScanSecondsPerTick = 0.003;
constexpr double SoftSampleSecondsPerActor = 0.020;

bool IsTerminal(EState State)
{
    return State == EState::Captured || State == EState::Partial ||
        State == EState::Cancelled || State == EState::Aborted;
}

bool IsCaptureId(const FString& Id)
{
    if (Id.Len() != 32) return false;
    for (const TCHAR Character : Id)
        if (!FChar::IsHexDigit(Character)) return false;
    return true;
}

struct FJob
{
    EState State = EState::Queued;
    FString TileId;
    FString CaptureId;
    int32 LOD = 0;
    FBox BoundsCm = FBox(EForceInit::ForceInit);
    TWeakObjectPtr<UWorld> World;
    FVector OriginCm = FVector::ZeroVector;
    TArray<TWeakObjectPtr<ULevel>> Levels;
    TArray<int32> ActorCounts;
    int32 InitialLevelCount = 0;
    int32 LevelCursor = 0;
    int32 ActorCursor = 0;
    int32 ScannedActorSlots = 0;
    TArray<TWeakObjectPtr<AActor>> EligibleActors;
    int32 ProcessedActorCount = 0;
    int32 PointCount = 0;
    TArray<FString> Gaps;
    HaybaWorldTileSnapshot::FTile Tile;
    FOnEvent Events;
};

class FService final
{
public:
    void Initialize()
    {
        check(IsInGameThread());
        if (bInitialized) return;
        bInitialized = true;
        UWorld* World = EditorWorld();
        ObservedWorld = World;
        ObservedOrigin = IsValid(World) ? FVector(World->OriginLocation) : FVector::ZeroVector;
        bObservedWorld = true;
        bWasUnsafe = FHaybaEditorHealth::IsUnsafe();
        BeginPIEHandle = FEditorDelegates::BeginPIE.AddRaw(this, &FService::OnBeginPIE);
        TickHandle = FTSTicker::GetCoreTicker().AddTicker(
            FTickerDelegate::CreateRaw(this, &FService::Tick), 0.0f);
    }

    void Shutdown()
    {
        check(IsInGameThread());
        if (!bInitialized) return;
        if (TickHandle.IsValid())
        {
            FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
            TickHandle.Reset();
        }
        if (BeginPIEHandle.IsValid())
        {
            FEditorDelegates::BeginPIE.Remove(BeginPIEHandle);
            BeginPIEHandle.Reset();
        }
        bInitialized = false;
        AbortAll(TEXT("capture_service_shutdown"));
        HaybaWorldTileSnapshot::Invalidate();
        Jobs.Reset();
        bObservedWorld = false;
        bWasBusy = false;
        bWasUnsafe = false;
    }

    FStartResult Start(UWorld* World, int32 LOD, int32 X, int32 Y, int32 Z)
    {
        FStartResult Result;
        Result.Status.State = EState::Rejected;
        if (!IsInGameThread())
        {
            Result.Error = TEXT("capture_requires_game_thread");
            return Result;
        }
        FBox Bounds(EForceInit::ForceInit);
        if (!HaybaWorldGeometry::TileBounds(LOD, X, Y, Z, Bounds))
        {
            Result.Error = TEXT("invalid_tile_address");
            return Result;
        }
        const FString TileId = HaybaWorldGeometry::TileId(LOD, X, Y, Z);
        Result.Status.TileId = TileId;
        if (!bInitialized)
        {
            Result.Error = TEXT("capture_service_unavailable");
            return Result;
        }
        ReconcileEditorState();
        if (!CanCapture(World))
        {
            Result.Error = TEXT("editor_world_unavailable_or_busy");
            return Result;
        }
        for (const TSharedPtr<FJob>& Job : Jobs)
        {
            if (Job->World.Get() == World && Job->TileId == TileId &&
                !IsTerminal(Job->State))
            {
                Result.Status = StatusFor(Job);
                Result.bDeduplicated = true;
                return Result;
            }
        }
        int32 QueuedCount = 0;
        for (const TSharedPtr<FJob>& Job : Jobs)
            if (Job->State == EState::Queued) ++QueuedCount;
        if (QueuedCount >= MaxQueuedRequests)
        {
            Result.Error = TEXT("tile_request_queue_full");
            return Result;
        }
        TSharedPtr<FJob> Job = MakeShared<FJob>();
        Job->TileId = TileId;
        Job->CaptureId = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        Job->LOD = LOD;
        Job->BoundsCm = Bounds;
        Job->World = World;
        Job->OriginCm = FVector(World->OriginLocation);
        Job->Tile.TileId = Job->TileId;
        Job->Tile.CaptureId = Job->CaptureId;
        Job->Tile.World = World;
        Job->Tile.WorldPath = World->GetPathName();
        Job->Tile.BoundsCm = Bounds;
        Job->Tile.OriginCm = Job->OriginCm;
        Job->Tile.LOD = LOD;
        Jobs.Add(Job);
        Prune();
        Result.Status = StatusFor(Job);
        return Result;
    }

    FStatus GetStatus(UWorld* World, const FString& Key)
    {
        FStatus Missing;
        if (!IsInGameThread()) return Missing;
        if (bInitialized) ReconcileEditorState();
        if (const TSharedPtr<FJob> Job = FindJob(World, Key)) return StatusFor(Job);
        if (!FHaybaEditorHealth::IsUnsafe() && IsValid(World))
        {
            const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Tile =
                IsCaptureId(Key)
                ? HaybaWorldTileSnapshot::GetByCaptureIdForWorld(World, Key)
                : HaybaWorldTileSnapshot::GetForWorld(World, Key);
            if (Tile.IsValid())
            {
                Missing.State = Tile->bPartial ? EState::Partial : EState::Captured;
                Missing.TileId = Tile->TileId;
                Missing.CaptureId = Tile->CaptureId;
                Missing.ScannedActorSlots = Tile->ScannedActorSlots;
                Missing.EligibleActorCount = Tile->EligibleActorCount;
                // The immutable tile contract does not store this counter.
                Missing.ProcessedActorCount = INDEX_NONE;
                Missing.PointCount = Tile->PointCount;
                Missing.PageCount = Tile->Pages.Num();
                Missing.Gaps = Tile->Gaps;
                Missing.Snapshot = Tile;
                return Missing;
            }
        }
        if (!IsCaptureId(Key)) Missing.TileId = Key;
        Missing.Gaps.Add(TEXT("tile_not_captured"));
        return Missing;
    }

    FStatus Cancel(UWorld* World, const FString& Key)
    {
        if (!IsInGameThread()) return FStatus();
        if (bInitialized) ReconcileEditorState();
        const TSharedPtr<FJob> Job = FindJob(World, Key);
        if (!Job.IsValid()) return GetStatus(World, Key);
        if (!IsTerminal(Job->State))
        {
            Job->Gaps.AddUnique(TEXT("capture_cancelled"));
            Job->State = EState::Cancelled;
            Emit(Job, EEventType::Done);
        }
        return StatusFor(Job);
    }

    FDelegateHandle Subscribe(const FString& CaptureId, const FOnEvent::FDelegate& Callback)
    {
        if (!IsInGameThread() || FHaybaEditorHealth::IsUnsafe() ||
            !Callback.IsBound() || !IsCaptureId(CaptureId))
            return FDelegateHandle();
        const TSharedPtr<FJob> Job = FindJob(nullptr, CaptureId);
        if (!Job.IsValid()) return FDelegateHandle();
        const FDelegateHandle Handle = Job->Events.Add(Callback);
        if (Job->State != EState::Queued && Job->State != EState::Cancelled &&
            Job->State != EState::Aborted)
        {
            FEvent Begin;
            Begin.Type = EEventType::Begin;
            Begin.Status = StatusFor(Job);
            Callback.ExecuteIfBound(Begin);
            const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Published =
                (Job->State == EState::Captured || Job->State == EState::Partial)
                ? HaybaWorldTileSnapshot::GetForWorld(Job->World.Get(), Job->TileId, Job->CaptureId)
                : nullptr;
            const TArray<HaybaWorldTileSnapshot::FPage>& Pages =
                Published.IsValid() && Published->CaptureId == Job->CaptureId
                ? Published->Pages : Job->Tile.Pages;
            for (const HaybaWorldTileSnapshot::FPage& Page : Pages)
            {
                FEvent PageEvent;
                PageEvent.Type = EEventType::Page;
                PageEvent.Status = StatusFor(Job);
                PageEvent.Page = MakeShared<const HaybaWorldTileSnapshot::FPage>(Page);
                Callback.ExecuteIfBound(PageEvent);
            }
        }
        if (IsTerminal(Job->State))
        {
            FEvent Done;
            Done.Type = EEventType::Done;
            Done.Status = StatusFor(Job);
            Callback.ExecuteIfBound(Done);
        }
        return Handle;
    }

    void Unsubscribe(const FString& CaptureId, FDelegateHandle Handle)
    {
        if (!IsInGameThread() || !Handle.IsValid()) return;
        if (const TSharedPtr<FJob> Job = FindJob(nullptr, CaptureId))
            Job->Events.Remove(Handle);
    }

private:
    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static bool EditorBusy()
    {
        return !GEditor || GEditor->PlayWorld || GEditor->IsPlaySessionRequestQueued();
    }

    bool CanCapture(UWorld* World) const
    {
        return !FHaybaEditorHealth::IsUnsafe() && IsValid(World) &&
            World->WorldType == EWorldType::Editor &&
            World == EditorWorld() && !EditorBusy();
    }

    void OnBeginPIE(bool /*bSimulating*/)
    {
        bWasBusy = true;
        HaybaWorldTileSnapshot::Invalidate();
        AbortAll(TEXT("pie_started"));
    }

    void ReconcileEditorState()
    {
        // A contained native fault makes UObject traversal unsafe. Abort the
        // queued work without reading editor-world or origin state again.
        if (FHaybaEditorHealth::IsUnsafe())
        {
            if (!bWasUnsafe)
            {
                bWasUnsafe = true;
                HaybaWorldTileSnapshot::Invalidate();
                AbortAll(TEXT("editor_unsafe"));
            }
            return;
        }
        bWasUnsafe = false;
        UWorld* Current = EditorWorld();
        const FVector Origin = IsValid(Current) ? FVector(Current->OriginLocation) : FVector::ZeroVector;
        const bool bWorldChanged = bObservedWorld &&
            (Current != ObservedWorld.Get() || !Origin.Equals(ObservedOrigin, 0.0));
        const bool bBusy = EditorBusy();
        const bool bBecameBusy = bBusy && !bWasBusy;
        // Commit the observation before callbacks; a subscriber may query
        // status synchronously from a Done event.
        ObservedWorld = Current;
        ObservedOrigin = Origin;
        bObservedWorld = true;
        bWasBusy = bBusy;
        if (bWorldChanged)
        {
            HaybaWorldTileSnapshot::Invalidate();
            AbortAll(TEXT("editor_world_or_origin_changed"));
        }
        if (bBecameBusy && !bWorldChanged)
        {
            HaybaWorldTileSnapshot::Invalidate();
            AbortAll(TEXT("editor_state_changed"));
        }
    }

    void AbortAll(const TCHAR* Reason)
    {
        TArray<TSharedPtr<FJob>> Active;
        for (const TSharedPtr<FJob>& Job : Jobs)
            if (!IsTerminal(Job->State)) Active.Add(Job);
        for (const TSharedPtr<FJob>& Job : Active)
        {
            if (IsTerminal(Job->State)) continue;
            Job->Gaps.AddUnique(Reason);
            Job->State = EState::Aborted;
            Emit(Job, EEventType::Done);
        }
    }

    TSharedPtr<FJob> FindJob(UWorld* World, const FString& Key) const
    {
        const bool bByCapture = IsCaptureId(Key);
        for (int32 Index = Jobs.Num() - 1; Index >= 0; --Index)
        {
            const TSharedPtr<FJob>& Job = Jobs[Index];
            if (bByCapture ? Job->CaptureId.Equals(Key, ESearchCase::IgnoreCase) :
                (Job->TileId == Key && Job->World.Get() == World))
                return Job;
        }
        return nullptr;
    }

    FStatus StatusFor(const TSharedPtr<FJob>& Job) const
    {
        FStatus Status;
        Status.State = Job->State;
        Status.TileId = Job->TileId;
        Status.CaptureId = Job->CaptureId;
        Status.ScannedActorSlots = Job->ScannedActorSlots;
        Status.EligibleActorCount = Job->EligibleActors.Num();
        Status.ProcessedActorCount = Job->ProcessedActorCount;
        Status.PointCount = Job->PointCount;
        Status.PageCount = Job->Tile.Pages.Num();
        Status.Gaps = Job->Gaps;
        if (FHaybaEditorHealth::IsUnsafe())
        {
            // After a contained fault, never touch the cached world or the
            // UObject-backed geometry even when this job finished earlier.
            Status.Snapshot.Reset();
            if (Status.State == EState::Captured || Status.State == EState::Partial)
                Status.State = EState::NotCaptured;
            Status.Gaps.AddUnique(TEXT("editor_unsafe"));
            return Status;
        }
        if (Job->State == EState::Captured || Job->State == EState::Partial)
        {
            Status.Snapshot = HaybaWorldTileSnapshot::GetForWorld(
                Job->World.Get(), Job->TileId, Job->CaptureId);
            if (!Status.Snapshot.IsValid() || Status.Snapshot->CaptureId != Job->CaptureId)
            {
                Status.Snapshot.Reset();
                Status.State = EState::NotCaptured;
                Status.Gaps.AddUnique(TEXT("tile_capture_evicted_or_replaced"));
            }
            else
            {
                Status.PageCount = Status.Snapshot->Pages.Num();
                Status.Gaps = Status.Snapshot->Gaps;
            }
        }
        return Status;
    }

    void Emit(const TSharedPtr<FJob>& Job, EEventType Type,
        TSharedPtr<const HaybaWorldTileSnapshot::FPage> Page = nullptr)
    {
        FEvent Event;
        Event.Type = Type;
        Event.Status = StatusFor(Job);
        Event.Page = MoveTemp(Page);
        Job->Events.Broadcast(Event);
    }

    void Prune()
    {
        while (Jobs.Num() > MaxRetainedJobs)
        {
            const int32 Index = Jobs.IndexOfByPredicate([](const TSharedPtr<FJob>& Job)
                { return IsTerminal(Job->State); });
            if (Index == INDEX_NONE) break;
            Jobs.RemoveAt(Index);
        }
    }

    bool Tick(float /*DeltaSeconds*/)
    {
        ReconcileEditorState();
        if (FHaybaEditorHealth::IsUnsafe() || EditorBusy()) return true;
        TSharedPtr<FJob> Active;
        for (const TSharedPtr<FJob>& Job : Jobs)
            if (Job->State == EState::Scanning || Job->State == EState::Sampling)
            { Active = Job; break; }
        if (!Active.IsValid())
        {
            for (const TSharedPtr<FJob>& Job : Jobs)
                if (Job->State == EState::Queued) { Active = Job; break; }
            if (!Active.IsValid()) return true;
            Begin(Active);
        }
        if (Active->State == EState::Scanning) Scan(Active);
        else if (Active->State == EState::Sampling) Sample(Active);
        return true;
    }

    void Begin(const TSharedPtr<FJob>& Job)
    {
        UWorld* World = Job->World.Get();
        if (!CanCapture(World) || !FVector(World->OriginLocation).Equals(Job->OriginCm, 0.0))
        {
            Job->Gaps.AddUnique(TEXT("editor_world_or_origin_changed"));
            Job->State = EState::Aborted;
            Emit(Job, EEventType::Done);
            return;
        }
        for (ULevel* Level : World->GetLevels())
        {
            if (!IsValid(Level))
            {
                Job->Gaps.AddUnique(TEXT("loaded_level_unavailable"));
                continue;
            }
            Job->Levels.Add(Level);
            Job->ActorCounts.Add(Level->Actors.Num());
        }
        Job->InitialLevelCount = World->GetLevels().Num();
        Job->State = EState::Scanning;
        Emit(Job, EEventType::Begin);
    }

    void Scan(const TSharedPtr<FJob>& Job)
    {
        UWorld* World = Job->World.Get();
        if (!CanCapture(World) || !FVector(World->OriginLocation).Equals(Job->OriginCm, 0.0))
        {
            Job->Gaps.AddUnique(TEXT("editor_world_or_origin_changed"));
            Job->State = EState::Aborted;
            Emit(Job, EEventType::Done);
            return;
        }
        if (World->GetLevels().Num() != Job->InitialLevelCount)
            Job->Gaps.AddUnique(TEXT("loaded_level_set_changed"));
        const double Started = FPlatformTime::Seconds();
        int32 SlotsThisTick = 0;
        bool bStop = false;
        while (Job->LevelCursor < Job->Levels.Num() &&
            SlotsThisTick < ScanSlotsPerTick &&
            FPlatformTime::Seconds() - Started < SoftScanSecondsPerTick)
        {
            ULevel* Level = Job->Levels[Job->LevelCursor].Get();
            if (!IsValid(Level))
            {
                Job->Gaps.AddUnique(TEXT("loaded_level_unavailable"));
                ++Job->LevelCursor;
                Job->ActorCursor = 0;
                continue;
            }
            const int32 InitialCount = Job->ActorCounts[Job->LevelCursor];
            if (Level->Actors.Num() != InitialCount)
                Job->Gaps.AddUnique(TEXT("loaded_level_changed"));
            if (Job->ActorCursor >= InitialCount)
            {
                ++Job->LevelCursor;
                Job->ActorCursor = 0;
                continue;
            }
            if (Job->ScannedActorSlots >= MaxScannedActorSlots)
            {
                Job->Gaps.AddUnique(TEXT("tile_actor_slot_cap"));
                bStop = true;
                break;
            }
            const int32 ActorIndex = Job->ActorCursor++;
            ++SlotsThisTick;
            ++Job->ScannedActorSlots;
            if (!Level->Actors.IsValidIndex(ActorIndex)) continue;
            AActor* Actor = Level->Actors[ActorIndex];
            if (!IsValid(Actor) || Actor->GetWorld() != World || Actor->IsEditorOnly()) continue;
            const FBox ActorBounds = Actor->GetComponentsBoundingBox(true);
            if (ActorBounds.IsValid && !ActorBounds.Intersect(Job->BoundsCm)) continue;
            bool bRelevant = false;
            int32 InspectedComponents = 0;
            for (UActorComponent* Component : Actor->GetComponents())
            {
                if (InspectedComponents >= MaxEligibilityComponentsPerActor)
                {
                    Job->Gaps.AddUnique(TEXT("tile_eligibility_component_cap"));
                    break;
                }
                ++InspectedComponents;
                if (!IsValid(Component) || !Component->IsRegistered()) continue;
                if (Component->IsA<UStaticMeshComponent>() ||
                    Component->IsA<USkeletalMeshComponent>() ||
                    Component->IsA<ULandscapeComponent>())
                { bRelevant = true; break; }
            }
            if (!bRelevant) continue;
            if (!ActorBounds.IsValid)
            {
                Job->Gaps.AddUnique(TEXT("relevant_actor_bounds_unavailable"));
                continue;
            }
            if (Job->EligibleActors.Num() >= MaxEligibleActors)
            {
                Job->Gaps.AddUnique(TEXT("tile_actor_cap"));
                bStop = true;
                break;
            }
            Job->EligibleActors.Add(Actor);
        }
        if (!bStop && Job->LevelCursor < Job->Levels.Num()) return;
        Job->EligibleActors.Sort([](const TWeakObjectPtr<AActor>& Left,
            const TWeakObjectPtr<AActor>& Right)
        {
            const AActor* A = Left.Get();
            const AActor* B = Right.Get();
            return A && B ? A->GetPathName() < B->GetPathName() : A != nullptr;
        });
        Job->State = EState::Sampling;
        if (Job->EligibleActors.IsEmpty()) Finish(Job);
    }

    void Sample(const TSharedPtr<FJob>& Job)
    {
        UWorld* World = Job->World.Get();
        if (!CanCapture(World) || !FVector(World->OriginLocation).Equals(Job->OriginCm, 0.0))
        {
            Job->Gaps.AddUnique(TEXT("editor_world_or_origin_changed"));
            Job->State = EState::Aborted;
            Emit(Job, EEventType::Done);
            return;
        }
        if (Job->ProcessedActorCount >= Job->EligibleActors.Num())
        {
            Finish(Job);
            return;
        }
        if (Job->PointCount >= MaxPointsPerTile)
        {
            Job->Gaps.AddUnique(TEXT("tile_point_cap"));
            Finish(Job);
            return;
        }
        const TWeakObjectPtr<AActor> WeakActor = Job->EligibleActors[Job->ProcessedActorCount++];
        AActor* Actor = WeakActor.Get();
        if (!IsValid(Actor) || Actor->GetWorld() != World)
        {
            Job->Gaps.AddUnique(TEXT("selected_actor_unavailable"));
            return;
        }
        if (!Actor->GetComponentsBoundingBox(true).Intersect(Job->BoundsCm))
        {
            Job->Gaps.AddUnique(TEXT("selected_actor_moved_outside_tile"));
            return;
        }
        const int32 RemainingActors = Job->EligibleActors.Num() - Job->ProcessedActorCount + 1;
        const int32 RemainingPoints = MaxPointsPerTile - Job->PointCount;
        const int32 PageLimit = FMath::Clamp(RemainingPoints / RemainingActors, 1, 4096);
        TArray<TWeakObjectPtr<AActor>> Batch;
        Batch.Add(WeakActor);
        HaybaWorldGeometry::FSnapshot Geometry = HaybaWorldGeometry::BuildTileBatch(
            World, Batch, Job->BoundsCm, PageLimit, SoftSampleSecondsPerActor);
        if (Geometry.VisitedActorCount < 1 || Geometry.ActorCount < 1)
            Job->Gaps.AddUnique(TEXT("tile_actor_processing_incomplete"));
        for (const FString& Gap : Geometry.StopReasons)
            Job->Gaps.AddUnique(Gap);
        if (Geometry.bTruncated && Geometry.StopReasons.IsEmpty())
            Job->Gaps.AddUnique(TEXT("tile_sampler_truncated"));
        if (Geometry.bDownsampled)
            Job->Gaps.AddUnique(TEXT("triangle_or_source_downsampled"));
        if (Geometry.bClusterPartial)
            Job->Gaps.AddUnique(TEXT("cluster_partial"));
        if (Geometry.bObservedInstanceCountSaturated)
            Job->Gaps.AddUnique(TEXT("instance_count_saturated"));
        for (const TPair<FString, int32>& Unsupported : Geometry.UnsupportedByKind)
            if (Unsupported.Value > 0)
                Job->Gaps.AddUnique(FString::Printf(TEXT("unsupported_%s"), *Unsupported.Key));
        Job->PointCount += Geometry.Splats.Num();
        HaybaWorldTileSnapshot::FPage Page;
        Page.PageId = Job->Tile.Pages.Num();
        Page.Geometry = MoveTemp(Geometry);
        const TSharedPtr<const HaybaWorldTileSnapshot::FPage> StreamPage =
            MakeShared<const HaybaWorldTileSnapshot::FPage>(Page);
        Job->Tile.Pages.Add(MoveTemp(Page));
        Emit(Job, EEventType::Page, StreamPage);
        if (Job->State != EState::Sampling) return;
        if (Job->PointCount >= MaxPointsPerTile &&
            Job->ProcessedActorCount < Job->EligibleActors.Num())
            Job->Gaps.AddUnique(TEXT("tile_point_cap"));
        if (Job->PointCount >= MaxPointsPerTile ||
            Job->ProcessedActorCount >= Job->EligibleActors.Num()) Finish(Job);
    }

    void Finish(const TSharedPtr<FJob>& Job)
    {
        UWorld* World = Job->World.Get();
        if (!CanCapture(World) || !FVector(World->OriginLocation).Equals(Job->OriginCm, 0.0))
        {
            Job->Gaps.AddUnique(TEXT("editor_world_or_origin_changed"));
            Job->State = EState::Aborted;
            Emit(Job, EEventType::Done);
            return;
        }
        Job->Tile.CapturedAtUtc = FDateTime::UtcNow().ToIso8601();
        Job->Tile.PointCount = Job->PointCount;
        Job->Tile.ScannedActorSlots = Job->ScannedActorSlots;
        Job->Tile.EligibleActorCount = Job->EligibleActors.Num();
        Job->Tile.bPartial = !Job->Gaps.IsEmpty();
        Job->Tile.Gaps = Job->Gaps;
        // Preserve these before the move: argument evaluation order is not a
        // safe place to read fields from a moved FTile.
        const FString TileId = Job->TileId;
        const FString CaptureId = Job->CaptureId;
        HaybaWorldTileSnapshot::Publish(MoveTemp(Job->Tile));
        const TSharedPtr<const HaybaWorldTileSnapshot::FTile> Published =
            HaybaWorldTileSnapshot::GetForWorld(World, TileId, CaptureId);
        if (!Published.IsValid() || Published->CaptureId != CaptureId)
        {
            Job->Gaps.AddUnique(TEXT("tile_publish_failed"));
            Job->State = EState::Aborted;
        }
        else Job->State = Published->bPartial ? EState::Partial : EState::Captured;
        Emit(Job, EEventType::Done);
    }

    TArray<TSharedPtr<FJob>> Jobs;
    TWeakObjectPtr<UWorld> ObservedWorld;
    FVector ObservedOrigin = FVector::ZeroVector;
    FTSTicker::FDelegateHandle TickHandle;
    FDelegateHandle BeginPIEHandle;
    bool bInitialized = false;
    bool bObservedWorld = false;
    bool bWasBusy = false;
    bool bWasUnsafe = false;
};

FService& Service()
{
    static FService Instance;
    return Instance;
}

bool ParseAddress(const FString& TileId, int32& LOD, int32& X, int32& Y, int32& Z)
{
    TArray<FString> Parts;
    TileId.ParseIntoArray(Parts, TEXT(":"), false);
    return Parts.Num() == 5 && Parts[0] == TEXT("tile") &&
        LexTryParseString(LOD, *Parts[1]) && LexTryParseString(X, *Parts[2]) &&
        LexTryParseString(Y, *Parts[3]) && LexTryParseString(Z, *Parts[4]) &&
        TileId == HaybaWorldGeometry::TileId(LOD, X, Y, Z);
}
}

const TCHAR* StateName(EState State)
{
    switch (State)
    {
    case EState::NotCaptured: return TEXT("not_captured");
    case EState::Rejected: return TEXT("rejected");
    case EState::Queued: return TEXT("queued");
    case EState::Scanning: return TEXT("scanning");
    case EState::Sampling: return TEXT("sampling");
    case EState::Captured: return TEXT("captured");
    case EState::Partial: return TEXT("partial");
    case EState::Cancelled: return TEXT("cancelled");
    case EState::Aborted: return TEXT("aborted");
    }
    return TEXT("unknown");
}

void Initialize() { Service().Initialize(); }
void Shutdown() { Service().Shutdown(); }

FStartResult Start(UWorld* World, int32 LOD, int32 X, int32 Y, int32 Z)
{
    return Service().Start(World, LOD, X, Y, Z);
}

FStartResult StartById(UWorld* World, const FString& TileId)
{
    int32 LOD = 0, X = 0, Y = 0, Z = 0;
    if (!ParseAddress(TileId, LOD, X, Y, Z))
    {
        FStartResult Result;
        Result.Status.State = EState::Rejected;
        Result.Status.TileId = TileId;
        Result.Error = TEXT("invalid_tile_address");
        return Result;
    }
    return Start(World, LOD, X, Y, Z);
}

FStatus GetStatus(UWorld* World, const FString& CaptureIdOrTileId)
{
    return Service().GetStatus(World, CaptureIdOrTileId);
}

FStatus Cancel(UWorld* World, const FString& CaptureIdOrTileId)
{
    return Service().Cancel(World, CaptureIdOrTileId);
}

FDelegateHandle Subscribe(const FString& CaptureId, const FOnEvent::FDelegate& Callback)
{
    return Service().Subscribe(CaptureId, Callback);
}

void Unsubscribe(const FString& CaptureId, FDelegateHandle Handle)
{
    Service().Unsubscribe(CaptureId, Handle);
}
}
