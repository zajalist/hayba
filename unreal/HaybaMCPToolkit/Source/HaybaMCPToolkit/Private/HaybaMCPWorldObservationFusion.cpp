#include "HaybaMCPWorldObservationFusion.h"
#include "Engine/World.h"
#include "HAL/PlatformMemory.h"
#include "GameFramework/Actor.h"
#include "Engine/Level.h"
#include "Components/PrimitiveComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Misc/Crc.h"

namespace HaybaWorldObservationFusion
{
uint32 SceneFingerprint(UWorld* World)
{
    if (!IsValid(World)) return 0;
    uint32 Hash = 2166136261u;
    const auto Mix = [&Hash](const FString& Value) { Hash = HashCombine(Hash, FCrc::StrCrc32(*Value)); };
    for (ULevel* Level : World->GetLevels())
    {
        if (!IsValid(Level)) continue;
        Mix(Level->GetPathName());
        for (AActor* Actor : Level->Actors)
        {
            if (!IsValid(Actor) || Actor->IsEditorOnly()) continue;
            Mix(Actor->GetPathName());
            Mix(Actor->GetActorTransform().ToString());
            Mix(Actor->IsHiddenEd() ? TEXT("hidden") : TEXT("visible"));
            for (UActorComponent* Component : Actor->GetComponents())
            {
                UPrimitiveComponent* Primitive = Cast<UPrimitiveComponent>(Component);
                if (!IsValid(Primitive)) continue;
                Mix(Primitive->GetPathName());
                Mix(Primitive->GetComponentTransform().ToString());
                Mix(Primitive->IsVisible() ? TEXT("visible") : TEXT("hidden"));
                if (const UStaticMeshComponent* StaticMesh = Cast<UStaticMeshComponent>(Primitive))
                    Mix(GetPathNameSafe(StaticMesh->GetStaticMesh()));
                for (int32 Slot = 0; Slot < Primitive->GetNumMaterials(); ++Slot)
                    Mix(GetPathNameSafe(Primitive->GetMaterial(Slot)));
            }
        }
    }
    return Hash;
}

int32 FStore::RecommendedResidentLimit()
{
    const uint64 GiB = 1024ull * 1024ull * 1024ull;
    const uint64 Physical = FPlatformMemory::GetConstants().TotalPhysical;
    const uint64 Available = FPlatformMemory::GetStats().AvailablePhysical;
    if (Physical < 4 * GiB || (Available > 0 && Available < 2 * GiB)) return 250000;
    if (Physical < 8 * GiB || (Available > 0 && Available < 4 * GiB)) return 500000;
    if (Physical < 16 * GiB || (Available > 0 && Available < 8 * GiB)) return 1000000;
    return MaxResidentPoints;
}

FStore::FStore(int32 InResidentLimit)
    : ResidentLimit(InResidentLimit > 0
        ? FMath::Clamp(InResidentLimit, 1, MaxResidentPoints)
        : RecommendedResidentLimit())
{}

uint64 FStore::AllocatedBytes() const
{
    uint64 Bytes = Points.GetAllocatedSize() + IndexByVoxel.GetAllocatedSize() +
        Captures.GetAllocatedSize();
    for (const TPair<uint32, FCapture>& Entry : Captures)
        Bytes += Entry.Value.Id.GetAllocatedSize() + Entry.Value.CapturedAtUtc.GetAllocatedSize();
    return Bytes;
}

FInt64Vector FStore::VoxelFor(const FVector& PositionCm)
{
    return FInt64Vector(FMath::FloorToInt64(PositionCm.X / VoxelSizeCm),
        FMath::FloorToInt64(PositionCm.Y / VoxelSizeCm),
        FMath::FloorToInt64(PositionCm.Z / VoxelSizeCm));
}

void FStore::Reset()
{
    BoundWorld.Reset();
    BoundOriginCm = FVector::ZeroVector;
    Points.Empty();
    IndexByVoxel.Empty();
    Captures.Empty();
    NextCaptureOrdinal = 1;
    NextEviction = 0;
    Duplicates = Evictions = 0;
}

bool FStore::Matches(const UWorld* World, const FVector& OriginCm) const
{
    return World && BoundWorld.Get() == World && BoundOriginCm.Equals(OriginCm, 0.0);
}

void FStore::BindWorld(UWorld* World, const FVector& OriginCm)
{
    if (Matches(World, OriginCm)) return;
    Reset();
    if (IsValid(World))
    {
        BoundWorld = World;
        BoundOriginCm = OriginCm;
    }
}

uint32 FStore::BeginCapture(const FString& Id, const FString& CapturedAtUtc,
    const FVector& CameraCm, const FRotator& Rotation)
{
    if (!BoundWorld.IsValid() || Id.IsEmpty()) return 0;
    const uint32 Ordinal = NextCaptureOrdinal++;
    FCapture Capture;
    Capture.Id = Id;
    Capture.CapturedAtUtc = CapturedAtUtc;
    Capture.CameraCm = CameraCm;
    Capture.Rotation = Rotation;
    Captures.Add(Ordinal, MoveTemp(Capture));
    return Ordinal;
}

void FStore::PruneEmptyCaptures()
{
    for (auto It = Captures.CreateIterator(); It; ++It)
        if (It.Value().ResidentPoints == 0) It.RemoveCurrent();
}

bool FStore::Add(uint32 CaptureOrdinal, const FVector& PositionCm, const FVector& Normal,
    const FColor& Color, HaybaWorldDepth::EColorSource ColorSource,
    int32 VerifiedActorIndex, int32 VerifiedNodeIndex, int32 AttributionGeneration)
{
    if (!Captures.Contains(CaptureOrdinal) || PositionCm.ContainsNaN() || !FMath::IsFinite(PositionCm.X) ||
        !FMath::IsFinite(PositionCm.Y) || !FMath::IsFinite(PositionCm.Z)) return false;
    const FInt64Vector Cell = VoxelFor(PositionCm);
    FPoint Incoming;
    Incoming.PositionCm = PositionCm;
    Incoming.Normal = Normal;
    Incoming.Color = Color;
    Incoming.ColorSource = ColorSource;
    Incoming.CaptureOrdinal = CaptureOrdinal;
    Incoming.VerifiedActorIndex = VerifiedActorIndex;
    Incoming.VerifiedNodeIndex = VerifiedNodeIndex;
    Incoming.AttributionGeneration = AttributionGeneration;
    if (int32* Existing = IndexByVoxel.Find(Cell))
    {
        FPoint& Resident = Points[*Existing];
        ++Duplicates;
        if (static_cast<uint8>(Resident.ColorSource) > static_cast<uint8>(ColorSource))
            return false; // keep the stronger BaseColor evidence and its provenance
        if (FCapture* Previous = Captures.Find(Resident.CaptureOrdinal))
        {
            if (--Previous->ResidentPoints == 0 && Resident.CaptureOrdinal != CaptureOrdinal)
                Captures.Remove(Resident.CaptureOrdinal);
        }
        Resident = Incoming; // latest aligned observation owns this voxel
        ++Captures.FindChecked(CaptureOrdinal).ResidentPoints;
        return false;
    }
    int32 Slot = Points.Num();
    if (Slot == ResidentLimit)
    {
        Slot = NextEviction;
        NextEviction = (NextEviction + 1) % ResidentLimit;
        const FPoint& Old = Points[Slot];
        IndexByVoxel.Remove(VoxelFor(Old.PositionCm));
        if (FCapture* Previous = Captures.Find(Old.CaptureOrdinal))
        {
            if (--Previous->ResidentPoints == 0 && Old.CaptureOrdinal != CaptureOrdinal)
                Captures.Remove(Old.CaptureOrdinal);
        }
        Points[Slot] = Incoming;
        ++Evictions;
    }
    else Points.Add(Incoming);
    IndexByVoxel.Add(Cell, Slot);
    ++Captures.FindChecked(CaptureOrdinal).ResidentPoints;
    return true;
}
}
