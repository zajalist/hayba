// HaybaSliverLoader.cpp
#include "Slivers/HaybaSliverLoader.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString FHaybaSliverLoader::DefaultUserSliversDir()
{
#if PLATFORM_WINDOWS
    FString Appdata = FPlatformMisc::GetEnvironmentVariable(TEXT("APPDATA"));
    if (Appdata.IsEmpty()) Appdata = FPaths::ProjectSavedDir();
    return FPaths::Combine(Appdata, TEXT("Hayba"), TEXT("slivers"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("Hayba"), TEXT("slivers"));
#endif
}

void FHaybaSliverLoader::Refresh(const FString& UserDir)
{
    Specs.Reset();
    LoadErrors.Reset();

    if (!IFileManager::Get().DirectoryExists(*UserDir)) return;

    TArray<FString> Files;
    IFileManager::Get().FindFiles(Files, *FPaths::Combine(UserDir, TEXT("*.sliver.json")), /*Files*/true, /*Dirs*/false);

    for (const FString& Name : Files)
    {
        const FString Full = FPaths::Combine(UserDir, Name);
        FString Raw;
        if (!FFileHelper::LoadFileToString(Raw, *Full))
        { LoadErrors.Add(FString::Printf(TEXT("%s: failed to read"), *Name)); continue; }

        TSharedPtr<FJsonObject> Obj;
        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
        if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
        { LoadErrors.Add(FString::Printf(TEXT("%s: invalid JSON"), *Name)); continue; }

        FHaybaSliverSpec Spec;
        FString Err;
        if (!ParseHaybaSliverSpec(Obj.ToSharedRef(), Spec, Err))
        { LoadErrors.Add(FString::Printf(TEXT("%s: %s"), *Name, *Err)); continue; }

        Specs.Add(MoveTemp(Spec));
    }
}

const FHaybaSliverSpec* FHaybaSliverLoader::Find(const FString& Id) const
{
    for (const FHaybaSliverSpec& S : Specs) if (S.Id == Id) return &S;
    return nullptr;
}
