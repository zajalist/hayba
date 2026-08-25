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
    return FPaths::Combine(Appdata, TEXT("Hayba"), TEXT("recipes"));
#else
    FString Home = FPlatformMisc::GetEnvironmentVariable(TEXT("HOME"));
    if (Home.IsEmpty()) Home = FPaths::ProjectSavedDir();
    return FPaths::Combine(Home, TEXT(".hayba"), TEXT("Hayba"), TEXT("recipes"));
#endif
}

bool FHaybaRecipeLoader::IsRecipeSpecFile(const FString& Name)
{
    // Recipes were called slivers, and specs already on disk are named for
    // that. Both spellings count as a spec.
    return Name.EndsWith(TEXT(".recipe.json")) || Name.EndsWith(TEXT(".sliver.json"));
}

FString FHaybaRecipeLoader::LegacyUserRecipesDir()
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

bool FHaybaRecipeLoader::MigrateLegacyLibrary(const FString& LegacyDir, const FString& UserDir)
{
    // The MCP server reads this same directory and runs the same migration
    // (recipes/loader.ts). Both are expected to race on startup, and losing
    // the race is fine: the directory move is atomic, so the loser simply
    // finds the destination already there and moves nothing.
    //
    // A move rather than a copy, deliberately -- two live libraries would
    // drift the moment either was edited, and nothing would say which counted.
    IFileManager& FM = IFileManager::Get();
    if (!FM.DirectoryExists(*LegacyDir)) return false;
    if (LegacyDir == UserDir) return false;

    if (!FM.DirectoryExists(*UserDir))
    {
        if (FM.Move(*UserDir, *LegacyDir, /*bReplace*/false))
        {
            UE_LOG(LogTemp, Log, TEXT("HaybaRecipeLoader: moved the recipe library to %s"), *UserDir);
            return true;
        }
        FM.MakeDirectory(*UserDir, /*Tree*/true);
    }

    // Destination exists (partly migrated, or the server got here first).
    // Move over only what is missing; never overwrite something newer.
    TArray<FString> Names;
    FM.FindFiles(Names, *FPaths::Combine(LegacyDir, TEXT("*.json")), /*Files*/true, /*Dirs*/false);

    int32 Moved = 0;
    for (const FString& Name : Names)
    {
        if (!IsRecipeSpecFile(Name)) continue;
        const FString To = FPaths::Combine(UserDir, Name);
        if (FM.FileExists(*To)) continue;
        if (FM.Move(*To, *FPaths::Combine(LegacyDir, Name), /*bReplace*/false)) ++Moved;
    }

    if (Moved > 0)
    {
        UE_LOG(LogTemp, Log, TEXT("HaybaRecipeLoader: moved %d recipe(s) to %s"), Moved, *UserDir);
    }
    return Moved > 0;
}

void FHaybaRecipeLoader::Refresh(const FString& UserDir)
{
    Specs.Reset();
    LoadErrors.Reset();

    if (!IFileManager::Get().DirectoryExists(*UserDir)) return;

    // Both suffixes load; only the new one is written. Mirrors the same
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
