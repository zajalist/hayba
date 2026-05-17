#include "HaybaMCPAudioHandler.h"

#include "Sound/SoundBase.h"
#include "Sound/SoundWave.h"
#include "Sound/SoundCue.h"
#include "Kismet/GameplayStatics.h"
#include "AudioDevice.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "UObject/SoftObjectPath.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Dom/JsonObject.h"

TArray<FString> FHaybaMCPAudioHandler::GetCommands() const
{
    return {
        TEXT("audio_play"),
        TEXT("audio_list"),
        TEXT("audio_set_volume")
    };
}

static FHaybaHandlerResult AudioPlay(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_play: missing params"));
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path))
        return FHaybaHandlerResult::Err(TEXT("audio_play: missing arg path"));

    double Volume = 1.0;
    double Pitch  = 1.0;
    P->TryGetNumberField(TEXT("volume"), Volume);
    P->TryGetNumberField(TEXT("pitch"),  Pitch);

    USoundBase* Sound = Cast<USoundBase>(FSoftObjectPath(Path).TryLoad());
    if (!Sound) return FHaybaHandlerResult::Err(FString::Printf(TEXT("audio_play: failed to load %s"), *Path));

    UWorld* World = GWorld;
    if (!World) return FHaybaHandlerResult::Err(TEXT("audio_play: no active world"));

    UGameplayStatics::PlaySound2D(World, Sound, (float)Volume, (float)Pitch);

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("playing"), Sound->GetName());
    Out->SetStringField(TEXT("path"), Path);
    Out->SetNumberField(TEXT("volume"), Volume);
    Out->SetNumberField(TEXT("pitch"),  Pitch);
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult AudioList(const TSharedPtr<FJsonObject>& P)
{
    FString Prefix;
    if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Prefix);

    FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
    IAssetRegistry& AR = ARM.Get();

    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(USoundBase::StaticClass()->GetClassPathName(), Assets, /*bSearchSubClasses=*/ true);

    TArray<TSharedPtr<FJsonValue>> Items;
    for (const FAssetData& A : Assets)
    {
        const FString ObjPath = A.GetObjectPathString();
        if (!Prefix.IsEmpty() && !ObjPath.StartsWith(Prefix)) continue;

        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), ObjPath);
        E->SetStringField(TEXT("name"), A.AssetName.ToString());
        E->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());

        // Try tag-based duration / sample rate (cheaper than loading).
        FString DurStr, SRStr;
        if (A.GetTagValue(TEXT("Duration"), DurStr))
        {
            E->SetNumberField(TEXT("duration_seconds"), FCString::Atod(*DurStr));
        }
        if (A.GetTagValue(TEXT("SampleRate"), SRStr))
        {
            E->SetNumberField(TEXT("sample_rate"), FCString::Atoi(*SRStr));
        }

        Items.Add(MakeShared<FJsonValueObject>(E));
    }

    auto Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("sounds"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult AudioSetVolume(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: missing params"));
    FString Category;
    if (!P->TryGetStringField(TEXT("category"), Category))
        return FHaybaHandlerResult::Err(TEXT("audio_set_volume: missing arg category"));
    double Volume = 1.0;
    if (!P->TryGetNumberField(TEXT("volume"), Volume))
        return FHaybaHandlerResult::Err(TEXT("audio_set_volume: missing arg volume"));

    if (!GEngine) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: no GEngine"));
    FAudioDeviceHandle Dev = GEngine->GetMainAudioDevice();
    if (!Dev.IsValid()) return FHaybaHandlerResult::Err(TEXT("audio_set_volume: no main audio device"));

    const FString Cat = Category.ToLower();
    if (Cat == TEXT("master"))
    {
        Dev->SetTransientPrimaryVolume((float)Volume);
    }
    else
    {
        // Implemented categories: "master". Other categories (music, sfx, ui, etc.)
        // would require Sound Class / Sound Mix routing — not implemented in this stub.
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("audio_set_volume: category '%s' not implemented (only 'master' supported)"),
            *Category));
    }

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("category"), Category);
    Out->SetNumberField(TEXT("volume"), Volume);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPAudioHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("audio_play"))       return AudioPlay(Params);
    if (Cmd == TEXT("audio_list"))       return AudioList(Params);
    if (Cmd == TEXT("audio_set_volume")) return AudioSetVolume(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("AudioHandler: unknown command %s"), *Cmd));
}
