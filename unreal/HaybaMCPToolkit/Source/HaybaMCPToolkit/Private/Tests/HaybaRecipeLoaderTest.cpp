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

// ── The library directory moved too ─────────────────────────────────────────
//
// Both halves read this directory, so they have to agree on where it is and
// both run the same migration. Losing that race must be harmless.

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
    FHaybaRecipeLoaderLibraryMoveTest,
    "Hayba.Recipes.Loader.LibraryMove",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FHaybaRecipeLoaderLibraryMoveTest::RunTest(const FString& Parameters)
{
    // Whole-directory move when the destination is absent.
    {
        const FString Root = MakeTempDir();
        const FString Legacy = FPaths::Combine(Root, TEXT("slivers"));
        const FString Target = FPaths::Combine(Root, TEXT("recipes"));
        IFileManager::Get().MakeDirectory(*Legacy, true);
        Write(Legacy, TEXT("com.test.moved.sliver.json"), SpecJson(TEXT("com.test.moved"), TEXT("Moved")));

        TestTrue(TEXT("migration reports a move"),
            FHaybaRecipeLoader::MigrateLegacyLibrary(Legacy, Target));

        // Moved, not copied -- two live libraries would drift.
        TestFalse(TEXT("old directory is gone"), IFileManager::Get().DirectoryExists(*Legacy));

        FHaybaRecipeLoader Loader;
        Loader.Refresh(Target);
        TestEqual(TEXT("spec survives the move"), Loader.List().Num(), 1);
        IFileManager::Get().DeleteDirectory(*Root, false, true);
    }

    // Destination already populated: fill gaps, never overwrite.
    {
        const FString Root = MakeTempDir();
        const FString Legacy = FPaths::Combine(Root, TEXT("slivers"));
        const FString Target = FPaths::Combine(Root, TEXT("recipes"));
        IFileManager::Get().MakeDirectory(*Legacy, true);
        IFileManager::Get().MakeDirectory(*Target, true);
        Write(Target, TEXT("com.test.dup.recipe.json"), SpecJson(TEXT("com.test.dup"), TEXT("Edited Since")));
        Write(Legacy, TEXT("com.test.dup.recipe.json"), SpecJson(TEXT("com.test.dup"), TEXT("Stale")));
        Write(Legacy, TEXT("com.test.extra.recipe.json"), SpecJson(TEXT("com.test.extra"), TEXT("Extra")));

        FHaybaRecipeLoader::MigrateLegacyLibrary(Legacy, Target);

        FHaybaRecipeLoader Loader;
        Loader.Refresh(Target);
        TestEqual(TEXT("both recipes present"), Loader.List().Num(), 2);
        if (const FHaybaRecipeSpec* Dup = Loader.Find(TEXT("com.test.dup")))
        {
            TestEqual(TEXT("the edited copy is not clobbered"), Dup->Title, FString(TEXT("Edited Since")));
        }
        IFileManager::Get().DeleteDirectory(*Root, false, true);
    }

    // Nothing to migrate is not an error, and must not create the target.
    {
        const FString Root = MakeTempDir();
        const FString Target = FPaths::Combine(Root, TEXT("recipes"));
        TestFalse(TEXT("no legacy library, no move"),
            FHaybaRecipeLoader::MigrateLegacyLibrary(FPaths::Combine(Root, TEXT("nope")), Target));
        TestFalse(TEXT("target not created"), IFileManager::Get().DirectoryExists(*Target));
        IFileManager::Get().DeleteDirectory(*Root, false, true);
    }

    return true;
}

#endif // WITH_EDITOR
