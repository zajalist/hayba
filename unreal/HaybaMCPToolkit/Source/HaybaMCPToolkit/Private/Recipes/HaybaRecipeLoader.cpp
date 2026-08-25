// HaybaRecipeLoader.cpp
#include "Recipes/HaybaRecipeLoader.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformProcess.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FString FHaybaRecipeLoader::DefaultUserRecipesDir()
{
#if PLATFORM_WINDOWS
    FString Appdata = FPlatformMisc::GetEnvironmentVariable(TEXT("APPDATA"));
    if (Appdata.IsEmpty()) Appdata = FPaths::ProjectSavedDir();
    // The directory keeps the old name deliberately -- the TS loader
    // (recipes/loader.ts) reads the same path and is pinned to it by a test.
    // Both halves move together, with a migration, or neither does.
    return FPaths::Combine(Appdata, TEXT("Hayba"), TEXT("slivers"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("Hayba"), TEXT("slivers"));
#endif
}

void FHaybaRecipeLoader::Refresh(const FString& UserDir)
{
    Specs.Reset();
    LoadErrors.Reset();

    if (!IFileManager::Get().DirectoryExists(*UserDir)) return;

    // Recipes were called slivers, and specs already on disk are named for
    // that. Both suffixes load; only the new one is written. Mirrors the same
    // decision in recipes/loader.ts so the two halves agree on what a spec is.
    TArray<FString> Files;
    IFileManager::Get().FindFiles(Files, *FPaths::Combine(UserDir, TEXT("*.recipe.json")), /*Files*/true, /*Dirs*/false);

    TArray<FString> LegacyFiles;
    IFileManager::Get().FindFiles(LegacyFiles, *FPaths::Combine(UserDir, TEXT("*.sliver.json")), /*Files*/true, /*Dirs*/false);
    Files.Append(LegacyFiles);

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

        FHaybaRecipeSpec Spec;
        FString Err;
        if (!ParseHaybaRecipeSpec(Obj.ToSharedRef(), Spec, Err))
        { LoadErrors.Add(FString::Printf(TEXT("%s: %s"), *Name, *Err)); continue; }

        // A library part-way through the rename holds both X.recipe.json and
        // X.sliver.json for the same recipe, and Specs is a flat array -- so
        // without this the panel lists every migrated recipe twice. The new
        // spelling is read first, so first-wins is the precedence we want.
        if (Specs.ContainsByPredicate([&Spec](const FHaybaRecipeSpec& S){ return S.Id == Spec.Id; }))
        {
            continue;
        }

        Specs.Add(MoveTemp(Spec));
    }
}

const FHaybaRecipeSpec* FHaybaRecipeLoader::Find(const FString& Id) const
{
    for (const FHaybaRecipeSpec& S : Specs) if (S.Id == Id) return &S;
    return nullptr;
}
