#include "Misc/AutomationTest.h"

#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Recipes/HaybaRecipeLoader.h"

#if WITH_EDITOR

namespace
{
    /** The smallest spec ParseHaybaRecipeSpec accepts, with a settable title so
     *  a test can tell two files for the same id apart. */
    FString SpecJson(const TCHAR* Id, const TCHAR* Title)
    {
        return FString::Printf(TEXT(R"({
            "id": "%s",
            "version": "1.0.0",
            "category": "test",
            "title": "%s",
            "description": "",
            "author": "test",
            "params": [],
            "executor": { "kind": "test.kind" },
            "determinism": {
                "pure": true, "declared_outputs": [], "side_effects": [],
                "reads": [], "seed_param": null
            }
        })"), Id, Title);
    }

    FString MakeTempDir()
    {
        const FString Dir = FPaths::Combine(
            FPaths::ProjectSavedDir(), TEXT("HaybaRecipeLoaderTest"),
            FGuid::NewGuid().ToString(EGuidFormats::Short));
        IFileManager::Get().MakeDirectory(*Dir, /*Tree*/true);
        return Dir;
    }

    void Write(const FString& Dir, const TCHAR* Name, const FString& Body)
    {
        FFileHelper::SaveStringToFile(Body, *FPaths::Combine(Dir, Name));
    }
}

// ── Recipes were called slivers ─────────────────────────────────────────────
//
// Specs users already have on disk are named <id>.sliver.json. They must keep
// loading, and a library part-way through the rename -- holding BOTH spellings
// of the same recipe -- must not show that recipe twice.

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaRecipeLoaderLegacyNameTest,
    "Hayba.Recipes.Loader.LegacySpecNames",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaRecipeLoaderLegacyNameTest::RunTest(const FString& Parameters)
{
    // A spec saved before the rename still loads.
    {
        const FString Dir = MakeTempDir();
        Write(Dir, TEXT("com.test.old.sliver.json"), SpecJson(TEXT("com.test.old"), TEXT("Old")));

        FHaybaRecipeLoader Loader;
        Loader.Refresh(Dir);

        TestEqual(TEXT("legacy-named spec loads"), Loader.List().Num(), 1);
        TestTrue(TEXT("no load errors"), Loader.Errors().IsEmpty());
        IFileManager::Get().DeleteDirectory(*Dir, false, true);
    }

    // Both spellings present for one id: listed once, current spelling wins.
    {
        const FString Dir = MakeTempDir();
        Write(Dir, TEXT("com.test.both.sliver.json"), SpecJson(TEXT("com.test.both"), TEXT("Old Name")));
        Write(Dir, TEXT("com.test.both.recipe.json"), SpecJson(TEXT("com.test.both"), TEXT("Current Name")));

        FHaybaRecipeLoader Loader;
        Loader.Refresh(Dir);

        // Specs is a flat array, so without dedup this is 2 and the panel shows
        // every migrated recipe twice.
        TestEqual(TEXT("half-migrated recipe listed once"), Loader.List().Num(), 1);
        if (Loader.List().Num() == 1)
        {
            TestEqual(TEXT("current spelling wins"), Loader.List()[0].Title, FString(TEXT("Current Name")));
        }
        IFileManager::Get().DeleteDirectory(*Dir, false, true);
    }

    // Two genuinely different recipes are still two.
    {
        const FString Dir = MakeTempDir();
        Write(Dir, TEXT("com.test.a.recipe.json"), SpecJson(TEXT("com.test.a"), TEXT("A")));
        Write(Dir, TEXT("com.test.b.sliver.json"), SpecJson(TEXT("com.test.b"), TEXT("B")));

        FHaybaRecipeLoader Loader;
        Loader.Refresh(Dir);

        TestEqual(TEXT("distinct ids both load"), Loader.List().Num(), 2);
        IFileManager::Get().DeleteDirectory(*Dir, false, true);
    }

    return true;
}

#endif // WITH_EDITOR
