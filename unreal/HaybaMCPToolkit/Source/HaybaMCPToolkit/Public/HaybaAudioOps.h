#pragma once

#include "CoreMinimal.h"

/** Pure parsing/path helpers for the audio handler. Kept outside the editor
 * execution half so the contract can be exercised by automation tests. */
namespace HaybaAudioOps
{
    enum class EAssetType : uint8
    {
        SoundClass,
        SoundMix,
        SoundConcurrency,
        SoundAttenuation,
        SoundSubmix,
        SoundWave,
        Unsupported,
    };

    struct FAssetTarget
    {
        FString ObjectPath;
        FString PackagePath;
        FString Directory;
        FString AssetName;
        FString Error;

        bool IsValid() const { return Error.IsEmpty(); }
    };

    /** Accept `/Game/Audio/SC_UI`, `/Game/Audio/SC_UI.SC_UI`, and UE export
     * text such as `SoundClass'/Game/Audio/SC_UI.SC_UI'`, producing one
     * canonical object path. */
    HAYBAMCPTOOLKIT_API FString NormalizeObjectPath(const FString& InPath);

    /** Resolve a full content asset target for creation. The input must name
     * the asset (a directory alone is intentionally ambiguous and rejected). */
    HAYBAMCPTOOLKIT_API FAssetTarget ResolveAssetTarget(const FString& InPath);

    HAYBAMCPTOOLKIT_API EAssetType ParseAssetType(const FString& InType);
    HAYBAMCPTOOLKIT_API FString AssetTypeName(EAssetType Type);
}
