// HaybaTagIndex.cpp
#include "HaybaTagIndex.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

const TArray<FString> FHaybaTagIndex::EmptyTags;

FString FHaybaTagIndex::DefaultSnapshotPath()
{
#if PLATFORM_WINDOWS
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("USERPROFILE"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("cache"), TEXT("retriever-tags.json"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("cache"), TEXT("retriever-tags.json"));
#endif
}

FHaybaTagIndex& FHaybaTagIndex::Get()
{
    static FHaybaTagIndex Singleton;
    return Singleton;
}

void FHaybaTagIndex::Invalidate()
{
    PathToTags.Reset();
    bLoaded = false;
    bLoadAttempted = false;
}

void FHaybaTagIndex::EnsureLoaded()
{
    if (bLoadAttempted) return;
    bLoadAttempted = true;

    const FString Path = DefaultSnapshotPath();
    if (!IFileManager::Get().FileExists(*Path))
    {
        UE_LOG(LogTemp, Log, TEXT("[HaybaTagIndex] snapshot not present at %s — falling back to actor tags only"), *Path);
        return;
    }

    FString Raw;
    if (!FFileHelper::LoadFileToString(Raw, *Path))
    {
        UE_LOG(LogTemp, Warning, TEXT("[HaybaTagIndex] failed to read %s"), *Path);
        return;
    }

    TSharedPtr<FJsonObject> Root;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
    if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
    {
        UE_LOG(LogTemp, Warning, TEXT("[HaybaTagIndex] %s is not valid JSON"), *Path);
        return;
    }

    for (const auto& KV : Root->Values)
    {
        if (!KV.Value.IsValid() || KV.Value->Type != EJson::Array) continue;
        TArray<FString>& Out = PathToTags.Add(KV.Key);
        for (const TSharedPtr<FJsonValue>& V : KV.Value->AsArray())
        {
            FString S;
            if (V.IsValid() && V->TryGetString(S)) Out.Add(S);
        }
    }
    bLoaded = true;
    UE_LOG(LogTemp, Log, TEXT("[HaybaTagIndex] loaded %d entries from %s"), PathToTags.Num(), *Path);
}

const TArray<FString>& FHaybaTagIndex::Lookup(const FString& AssetPath) const
{
    const_cast<FHaybaTagIndex*>(this)->EnsureLoaded();
    if (const TArray<FString>* Found = PathToTags.Find(AssetPath)) return *Found;
    return EmptyTags;
}
