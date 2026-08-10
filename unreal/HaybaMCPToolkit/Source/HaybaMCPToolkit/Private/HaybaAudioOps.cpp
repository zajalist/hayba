#include "HaybaAudioOps.h"

#include "Misc/PackageName.h"

namespace HaybaAudioOps
{
    FString NormalizeObjectPath(const FString& InPath)
    {
        FString Path = InPath.TrimStartAndEnd();
        if (Path.IsEmpty()) return Path;

        // Accept Unreal export-text references without making every caller
        // manually strip the class prefix and quotes.
        int32 FirstQuote = INDEX_NONE;
        int32 LastQuote = INDEX_NONE;
        if (Path.FindChar(TEXT('\''), FirstQuote) && Path.FindLastChar(TEXT('\''), LastQuote)
            && LastQuote > FirstQuote)
        {
            Path = Path.Mid(FirstQuote + 1, LastQuote - FirstQuote - 1);
        }

        Path.ReplaceInline(TEXT("\\"), TEXT("/"));
        while (Path.EndsWith(TEXT("/"))) Path.LeftChopInline(1);

        if (!Path.StartsWith(TEXT("/"))) return Path;

        // A canonical object path already contains the package/object dot.
        const FString PackageName = FPackageName::ObjectPathToPackageName(Path);
        if (PackageName != Path) return Path;

        const FString AssetName = FPackageName::GetLongPackageAssetName(Path);
        if (AssetName.IsEmpty()) return Path;
        return FString::Printf(TEXT("%s.%s"), *Path, *AssetName);
    }

    FAssetTarget ResolveAssetTarget(const FString& InPath)
    {
        FAssetTarget Out;
        Out.ObjectPath = NormalizeObjectPath(InPath);
        Out.PackagePath = FPackageName::ObjectPathToPackageName(Out.ObjectPath);
        Out.AssetName = FPackageName::GetLongPackageAssetName(Out.PackagePath);
        Out.Directory = FPackageName::GetLongPackagePath(Out.PackagePath);

        if (!Out.PackagePath.StartsWith(TEXT("/Game/")))
        {
            Out.Error = TEXT("audio asset path must be under /Game and name an asset");
        }
        else if (!FPackageName::IsValidLongPackageName(Out.PackagePath))
        {
            Out.Error = FString::Printf(TEXT("invalid Unreal package path: %s"), *Out.PackagePath);
        }
        else if (Out.AssetName.IsEmpty() || Out.Directory.IsEmpty())
        {
            Out.Error = TEXT("audio asset path must include a non-empty asset name");
        }
        return Out;
    }

    EAssetType ParseAssetType(const FString& InType)
    {
        FString Type = InType.TrimStartAndEnd().ToLower();
        Type.ReplaceInline(TEXT("_"), TEXT(""));
        Type.ReplaceInline(TEXT(" "), TEXT(""));
        if (Type == TEXT("soundclass")) return EAssetType::SoundClass;
        if (Type == TEXT("soundmix")) return EAssetType::SoundMix;
        if (Type == TEXT("soundconcurrency") || Type == TEXT("concurrency")) return EAssetType::SoundConcurrency;
        if (Type == TEXT("soundattenuation") || Type == TEXT("attenuation")) return EAssetType::SoundAttenuation;
        if (Type == TEXT("soundsubmix") || Type == TEXT("submix")) return EAssetType::SoundSubmix;
        if (Type == TEXT("soundwave") || Type == TEXT("wave")) return EAssetType::SoundWave;
        return EAssetType::Unsupported;
    }

    FString AssetTypeName(const EAssetType Type)
    {
        switch (Type)
        {
        case EAssetType::SoundClass: return TEXT("SoundClass");
        case EAssetType::SoundMix: return TEXT("SoundMix");
        case EAssetType::SoundConcurrency: return TEXT("SoundConcurrency");
        case EAssetType::SoundAttenuation: return TEXT("SoundAttenuation");
        case EAssetType::SoundSubmix: return TEXT("SoundSubmix");
        case EAssetType::SoundWave: return TEXT("SoundWave");
        default: return TEXT("Unsupported");
        }
    }
}
