#pragma once
#include "CoreMinimal.h"

// Plain (non-UObject) mirror of the PLUMB Mask/Profile JSON the MCP server writes
// under .scratch/profiles.json. The Studio loads these read-mostly; edits are
// written back via SaveProfile. Field set matches Plan A's `Mask` type.

struct FHaybaStudioMaskShape
{
    FString  Kind = TEXT("box");       // box | sphere | capsule | convex
    FVector  Pos = FVector::ZeroVector; // shape.transform.pos, METRES (local)
    FQuat    Rot = FQuat::Identity;     // shape.transform.quat
    FVector  Extents = FVector(0.5f);   // shape.extents, METRES
    float    Radius = 0.5f;             // shape.radius, METRES
};

struct FHaybaStudioMask
{
    FString      Id;
    FString      Type = TEXT("volume"); // surface | volume
    FString      Source = TEXT("human");
    FString      Detail;
    FLinearColor Color = FLinearColor(0.25f, 0.55f, 1.f);
    float        Confidence = 1.f;
    bool         bLocked = false;
    TArray<int32> Triangles;            // surface masks
    bool         bHasShape = false;     // volume masks
    FHaybaStudioMaskShape Shape;
};

struct FHaybaStudioProfile
{
    FString AssetId;
    FString Archetype;
    TArray<FHaybaStudioMask> Masks;
    bool bLoaded = false;
};

namespace HaybaStudio
{
    /** Directory the MCP server writes the PLUMB stores to: env HAYBA_PROFILES's
     *  dir if set, else ProjectDir/.scratch (mirrors HaybaMCPMemoryPanel). */
    FString ScratchDir();

    /** Load the profile for AssetPath from .scratch/profiles.json. Returns false
     *  (and leaves Out.bLoaded=false) when the file or entry is missing. */
    bool LoadProfile(const FString& AssetPath, FHaybaStudioProfile& Out);
}
