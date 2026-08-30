#include "HaybaMCPLevelHandler.h"
#include "HaybaMCPParams.h"
#include "Json.h"
#include "Editor.h"
#include "FileHelpers.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "LevelEditor.h"
#include "Engine/World.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "Misc/PackageName.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPLevel, Log, All);

// ---------------------------------------------------------------------------
// Transient-reference sanitizer
//
// Saving a .umap fails hard ("Illegal reference to private object") when a
// component in the persistent level references a StaticMesh that lives in a
// transient/private package — most commonly a stale HLOD proxy
// (LandscapeMeshProxyComponent on an "HLOD0_Instancing" actor) carried over
// from the OpenWorld template, whose mesh was built into /Temp/... rather than
// a saved asset. Those proxy meshes are derived data: clearing the dangling
// reference lets the map save, and a real BuildHLODs regenerates them.
//
// We clear the offending StaticMesh reference (rather than destroying the
// actor) so nothing legitimate is lost, and report what was cleaned.
// ---------------------------------------------------------------------------
static bool IsTransientPackageRef(const UObject* Obj)
{
    if (!Obj) return false;
    const UPackage* Pkg = Obj->GetOutermost();
    if (!Pkg) return false;
    if (Pkg == GetTransientPackage()) return true;
    if (Obj->HasAnyFlags(RF_Transient) || Pkg->HasAnyFlags(RF_Transient)) return true;
    const FString PkgName = Pkg->GetName();
    // Not a persistable content/engine asset path → illegal to reference on save.
    return PkgName.StartsWith(TEXT("/Temp/")) || PkgName.StartsWith(TEXT("/Engine/Transient"));
}

struct FSanitizedStaticMeshRef
{
    TWeakObjectPtr<UStaticMeshComponent> Component;
    TWeakObjectPtr<UStaticMesh> Mesh;
};

static int32 SanitizeTransientStaticMeshRefs(
    UWorld* World,
    TArray<FString>& OutCleaned,
    TArray<FSanitizedStaticMeshRef>* OutRestore = nullptr)
{
    if (!World) return 0;
    int32 Count = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        // level_save writes only the current level. Do not dirty actors in
        // streamed/sub-level packages while repairing the package being saved.
        if (A->GetLevel() != World->GetCurrentLevel()) continue;
        TArray<UStaticMeshComponent*> Comps;
        A->GetComponents(Comps);
        for (UStaticMeshComponent* C : Comps)
        {
            if (!C) continue;
            UStaticMesh* SM = C->GetStaticMesh();
            if (SM && IsTransientPackageRef(SM))
            {
                if (OutRestore)
                {
                    FSanitizedStaticMeshRef Restore;
                    Restore.Component = C;
                    Restore.Mesh = SM;
                    OutRestore->Add(Restore);
                }
                C->Modify();
                C->SetStaticMesh(nullptr);
                OutCleaned.Add(FString::Printf(TEXT("%s.%s -> %s"), *A->GetName(), *C->GetName(), *SM->GetName()));
                ++Count;
            }
        }
    }
    return Count;
}

static void RestoreSanitizedStaticMeshRefs(const TArray<FSanitizedStaticMeshRef>& Refs)
{
    for (const FSanitizedStaticMeshRef& Ref : Refs)
    {
        UStaticMeshComponent* Component = Ref.Component.Get();
        UStaticMesh* Mesh = Ref.Mesh.Get();
        if (Component && Mesh) Component->SetStaticMesh(Mesh);
    }
}

// Bookmarks are scoped to the world in which they were captured. A global
// transform applied after level_load used to teleport the viewport using stale
// context from a different map while still claiming success.
struct FHaybaLevelBookmark
{
    FString WorldPackage;
    FTransform Transform;
};
static TMap<FString, FHaybaLevelBookmark> GHaybaBookmarkMap;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

TArray<FString> FHaybaMCPLevelHandler::GetCommands() const
{
    return {
        TEXT("level_list"),
        TEXT("level_load"),
        TEXT("level_save"),
        TEXT("level_create"),
        TEXT("level_get_info"),
        TEXT("level_get_spatial_index"),
        TEXT("level_set_bookmark"),
        TEXT("level_goto_bookmark"),
    };
}

FHaybaHandlerResult FHaybaMCPLevelHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("level_list"))              return LevelList(Params);
    if (Cmd == TEXT("level_load"))              return LevelLoad(Params);
    if (Cmd == TEXT("level_save"))              return LevelSave(Params);
    if (Cmd == TEXT("level_create"))            return LevelCreate(Params);
    if (Cmd == TEXT("level_get_info"))          return LevelGetInfo(Params);
    if (Cmd == TEXT("level_get_spatial_index")) return LevelGetSpatialIndex(Params);
    if (Cmd == TEXT("level_set_bookmark"))      return LevelSetBookmark(Params);
    if (Cmd == TEXT("level_goto_bookmark"))     return LevelGotoBookmark(Params);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("LevelHandler: unknown command %s"), *Cmd));
}

// ---------------------------------------------------------------------------
// level_list
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelList(const TSharedPtr<FJsonObject>& P)
{
    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UWorld::StaticClass()->GetClassPathName(), Assets);

    TArray<TSharedPtr<FJsonValue>> Levels;
    for (const FAssetData& Asset : Assets)
    {
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
        Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());
        Levels.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("levels"), Levels);
    Out->SetNumberField(TEXT("count"), Levels.Num());
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_load
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelLoad(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("level_load"));
    const FString Path = R.RequiredString(TEXT("path"), 2048);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    // Normalize and prove the destination exists before asking the editor to
    // replace its world. LoadMap can otherwise get as far as a world transition
    // (or an interactive failure path) before discovering a typo.
    FString ExpectedPath = Path;
    FString FilenamePackage;
    if (FPackageName::TryConvertFilenameToLongPackageName(Path, FilenamePackage))
        ExpectedPath = FilenamePackage;
    else if (ExpectedPath.StartsWith(TEXT("/")) && ExpectedPath.Contains(TEXT(".")))
        ExpectedPath = FPackageName::ObjectPathToPackageName(ExpectedPath);
    if (!FPackageName::IsValidLongPackageName(ExpectedPath)
        || !FPackageName::DoesPackageExist(ExpectedPath))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("level_load: target is not an existing map package: %s. Nothing was changed."),
            *Path));
    }
    IAssetRegistry& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    const FString ExpectedObjectPath = ExpectedPath + TEXT(".") + FPackageName::GetShortName(ExpectedPath);
    const FAssetData MapAsset = Registry.GetAssetByObjectPath(FSoftObjectPath(ExpectedObjectPath));
    if (!MapAsset.IsValid() || MapAsset.AssetClassPath != UWorld::StaticClass()->GetClassPathName())
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("level_load: '%s' exists but is not a UWorld map asset. Nothing was changed."),
            *ExpectedPath));
    }
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("level_load: editor not available"));
    if (GEditor->IsPlayingSessionInEditor())
        return FHaybaHandlerResult::Err(TEXT("level_load: cannot replace the editor world while PIE/SIE is running; stop play first. Nothing was changed."));
    if (UWorld* Current = GEditor->GetEditorWorldContext().World())
    {
        if (UPackage* CurrentPackage = Current->GetOutermost(); CurrentPackage && CurrentPackage->IsDirty())
        {
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("level_load: current map '%s' has unsaved changes. Call level_save first; nothing was changed."),
                *CurrentPackage->GetName()));
        }
    }

    bool bLoaded = FEditorFileUtils::LoadMap(Path, false, false);
    if (!bLoaded)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_load: LoadMap failed for path: %s"), *Path));

    UWorld* LoadedWorld = GEditor->GetEditorWorldContext().World();
    const FString ObservedPath = LoadedWorld && LoadedWorld->GetOutermost()
        ? LoadedWorld->GetOutermost()->GetName()
        : FString();
    const bool bVerified = !ObservedPath.IsEmpty()
        && ObservedPath.Equals(ExpectedPath, ESearchCase::IgnoreCase);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("loaded"), bVerified);
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetStringField(TEXT("requested_path"), Path);
    Out->SetStringField(TEXT("path"), ObservedPath);
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("LoadMap returned true but the current editor world does not match the requested package. Treat the world transition outcome as unknown and inspect level_get_info before retrying."));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_save
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSave(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("level_save: editor not available"));
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World || !World->GetCurrentLevel())
        return FHaybaHandlerResult::Err(TEXT("level_save: no current editor level; nothing was changed"));
    if (GEditor->IsPlayingSessionInEditor())
        return FHaybaHandlerResult::Err(TEXT("level_save: refusing to save the editor map while PIE/SIE is running; stop play first. Nothing was changed."));

    UPackage* LevelPackage = World->GetCurrentLevel()->GetOutermost();
    const bool bWasDirty = LevelPackage && LevelPackage->IsDirty();

    // Strip dangling transient mesh refs (stale HLOD proxies) that would
    // otherwise fail the save with "Illegal reference to private object".
    TArray<FString> Cleaned;
    TArray<FSanitizedStaticMeshRef> Restore;
    SanitizeTransientStaticMeshRefs(World, Cleaned, &Restore);

    const bool bSaved = FEditorFileUtils::SaveCurrentLevel();
    if (!bSaved)
    {
        // The sanitizer is part of execute, not preflight. If persistence
        // fails, restore the exact references and dirty state so an error does
        // not quietly become a destructive edit.
        RestoreSanitizedStaticMeshRefs(Restore);
        if (LevelPackage) LevelPackage->SetDirtyFlag(bWasDirty);
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("level_save: SaveCurrentLevel failed; restored %d transient mesh reference(s). Observed component state and the original dirty flag were restored; inspect the editor log before retrying."),
            Restore.Num()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("saved"), true);
    Out->SetBoolField(TEXT("dirty"), LevelPackage && LevelPackage->IsDirty());
    const bool bVerified = LevelPackage
        && !LevelPackage->IsDirty()
        && FPackageName::DoesPackageExist(LevelPackage->GetName());
    Out->SetBoolField(TEXT("verified"), bVerified);
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("SaveCurrentLevel returned true, but the current package is still dirty or cannot be found on disk. Verify the map file before closing the editor."));
    if (Cleaned.Num() > 0)
    {
        TArray<TSharedPtr<FJsonValue>> Arr;
        for (const FString& C : Cleaned) Arr.Add(MakeShared<FJsonValueString>(C));
        Out->SetArrayField(TEXT("cleaned_transient_refs"), Arr);
    }
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_create
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelCreate(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("level_create"));
    const FString Path = R.RequiredString(TEXT("path"), 2048);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());
    if (!FPackageName::IsValidLongPackageName(Path) || !Path.StartsWith(TEXT("/Game/")))
        return FHaybaHandlerResult::Err(TEXT("level_create: 'path' must be an unused long package name under /Game (for example /Game/Maps/MyLevel). Nothing was changed."));
    if (FPackageName::DoesPackageExist(Path) || FindPackage(nullptr, *Path))
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_create: target already exists: %s. Nothing was changed."), *Path));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("level_create: GEditor is null"));
    if (GEditor->IsPlayingSessionInEditor())
        return FHaybaHandlerResult::Err(TEXT("level_create: cannot replace the editor world while PIE/SIE is running; stop play first. Nothing was changed."));

    FString PreviousWorld;
    if (UWorld* Current = GEditor->GetEditorWorldContext().World())
    {
        if (UPackage* CurrentPackage = Current->GetOutermost())
        {
            PreviousWorld = CurrentPackage->GetName();
            if (CurrentPackage->IsDirty())
                return FHaybaHandlerResult::Err(FString::Printf(
                    TEXT("level_create: current map '%s' has unsaved changes. Save it first; nothing was changed."),
                    *PreviousWorld));
        }
    }

    GEditor->CreateNewMapForEditing(/*bPromptUserToSave=*/false);
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("level_create: no editor world after CreateNewMapForEditing"));

    // Defensive: a freshly created map is clean, but if a template world is ever
    // used here, strip stale transient HLOD refs so the first save can't fail.
    TArray<FString> Cleaned;
    SanitizeTransientStaticMeshRefs(World, Cleaned);

    const bool bSaved = FEditorFileUtils::SaveLevel(World->GetCurrentLevel(), *Path);
    if (!bSaved)
    {
        // CreateNewMapForEditing has already replaced the world. Returning a
        // plain error would falsely classify this as a preflight rejection.
        TSharedPtr<FJsonObject> Partial = MakeShared<FJsonObject>();
        Partial->SetBoolField(TEXT("created"), false);
        Partial->SetBoolField(TEXT("saved"), false);
        Partial->SetBoolField(TEXT("world_changed"), true);
        Partial->SetBoolField(TEXT("dirty"), World->GetOutermost()->IsDirty());
        Partial->SetStringField(TEXT("path"), Path);
        Partial->SetStringField(TEXT("previous_world"), PreviousWorld);
        Partial->SetStringField(TEXT("warning"),
            TEXT("SaveLevel failed after the editor switched to a new unsaved map. Do not retry blindly: inspect the current world, then either save it to a valid unused /Game path or reload previous_world."));
        return FHaybaHandlerResult::Ok(Partial);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    const FString ObservedPath = World->GetOutermost()->GetName();
    const bool bVerified = ObservedPath.Equals(Path, ESearchCase::IgnoreCase)
        && FPackageName::DoesPackageExist(Path);
    Out->SetBoolField(TEXT("created"), bVerified);
    Out->SetBoolField(TEXT("saved"), true);
    Out->SetBoolField(TEXT("world_changed"), true);
    Out->SetBoolField(TEXT("dirty"), World->GetOutermost()->IsDirty());
    Out->SetStringField(TEXT("path"), Path);
    Out->SetStringField(TEXT("observed_path"), ObservedPath);
    Out->SetBoolField(TEXT("verified"), bVerified);
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("SaveLevel returned true, but the current world/package could not be verified at the requested path. Inspect level_get_info and the Content Browser before retrying."));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_get_info
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelGetInfo(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("level_get_info: GEditor is null"));

    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("level_get_info: no editor world"));

    int32 ActorCount = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
        ++ActorCount;

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("map_name"),     World->GetMapName());
    Out->SetStringField(TEXT("package_path"), World->GetOutermost()->GetName());
    Out->SetNumberField(TEXT("actor_count"),  ActorCount);
    Out->SetBoolField(TEXT("is_pie_running"), GEditor->IsPlayingSessionInEditor());
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_get_spatial_index
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelGetSpatialIndex(const TSharedPtr<FJsonObject>& P)
{
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("status"), TEXT("deferred"));
    Out->SetStringField(TEXT("see"),    TEXT("scene_export"));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_set_bookmark
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSetBookmark(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("level_set_bookmark"));
    const FString Name = R.RequiredString(TEXT("name"), 256);
    const TOptional<FVector> RequestedLocation = R.OptionalVec3(TEXT("location"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("level_set_bookmark: editor not available; nothing was stored"));
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World) return FHaybaHandlerResult::Err(TEXT("level_set_bookmark: no editor world; nothing was stored"));

    FVector Location = FVector::ZeroVector;
    FRotator Rotation = FRotator::ZeroRotator;
    if (RequestedLocation.IsSet()) Location = RequestedLocation.GetValue();
    else
    {
        // Use current viewport position
        FViewport* Viewport = GEditor->GetActiveViewport();
        FEditorViewportClient* VPC = Viewport
            ? static_cast<FEditorViewportClient*>(Viewport->GetClient())
            : nullptr;
        if (!VPC)
            return FHaybaHandlerResult::Err(TEXT("level_set_bookmark: no active level viewport and no explicit location was supplied; nothing was stored"));
        Location = VPC->GetViewLocation();
        Rotation = VPC->GetViewRotation();
    }

    FTransform T(Rotation, Location);
    FHaybaLevelBookmark Bookmark;
    Bookmark.WorldPackage = World->GetOutermost()->GetName();
    Bookmark.Transform = T;
    GHaybaBookmarkMap.Add(Name, Bookmark);

    TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
    LocObj->SetNumberField(TEXT("x"), Location.X);
    LocObj->SetNumberField(TEXT("y"), Location.Y);
    LocObj->SetNumberField(TEXT("z"), Location.Z);

    TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
    RotObj->SetNumberField(TEXT("pitch"), Rotation.Pitch);
    RotObj->SetNumberField(TEXT("yaw"),   Rotation.Yaw);
    RotObj->SetNumberField(TEXT("roll"),  Rotation.Roll);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"),     Name);
    Out->SetObjectField(TEXT("location"), LocObj);
    Out->SetObjectField(TEXT("rotation"), RotObj);
    const FHaybaLevelBookmark* Stored = GHaybaBookmarkMap.Find(Name);
    Out->SetBoolField(TEXT("verified"), Stored
        && Stored->WorldPackage == Bookmark.WorldPackage
        && Stored->Transform.Equals(Bookmark.Transform));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_goto_bookmark
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelGotoBookmark(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("level_goto_bookmark"));
    const FString Name = R.RequiredString(TEXT("name"), 256);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    const FHaybaLevelBookmark* Bookmark = GHaybaBookmarkMap.Find(Name);
    if (!Bookmark)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_goto_bookmark: bookmark not found: %s"), *Name));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("level_goto_bookmark: editor not available"));
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("level_goto_bookmark: no editor world; viewport was not changed"));
    const FString CurrentWorld = World->GetOutermost()->GetName();
    if (Bookmark->WorldPackage != CurrentWorld)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("level_goto_bookmark: '%s' belongs to world '%s', but the current world is '%s'. Reload the original world or capture a new bookmark; viewport was not changed."),
            *Name, *Bookmark->WorldPackage, *CurrentWorld));

    FVector Location = Bookmark->Transform.GetLocation();
    FRotator Rotation = Bookmark->Transform.Rotator();

    FViewport* Viewport = GEditor->GetActiveViewport();
    FEditorViewportClient* VPC = Viewport
        ? static_cast<FEditorViewportClient*>(Viewport->GetClient())
        : nullptr;
    if (!VPC)
        return FHaybaHandlerResult::Err(TEXT("level_goto_bookmark: no active level viewport; viewport was not changed"));

    VPC->SetViewLocation(Location);
    VPC->SetViewRotation(Rotation);
    VPC->Invalidate();

    TSharedPtr<FJsonObject> LocObj = MakeShared<FJsonObject>();
    LocObj->SetNumberField(TEXT("x"), Location.X);
    LocObj->SetNumberField(TEXT("y"), Location.Y);
    LocObj->SetNumberField(TEXT("z"), Location.Z);

    TSharedPtr<FJsonObject> RotObj = MakeShared<FJsonObject>();
    RotObj->SetNumberField(TEXT("pitch"), Rotation.Pitch);
    RotObj->SetNumberField(TEXT("yaw"),   Rotation.Yaw);
    RotObj->SetNumberField(TEXT("roll"),  Rotation.Roll);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"),     Name);
    Out->SetObjectField(TEXT("location"), LocObj);
    Out->SetObjectField(TEXT("rotation"), RotObj);
    const bool bVerified = VPC->GetViewLocation().Equals(Location)
        && VPC->GetViewRotation().Equals(Rotation);
    Out->SetBoolField(TEXT("verified"), bVerified);
    if (!bVerified)
    {
        Out->SetStringField(TEXT("warning"),
            TEXT("The viewport setters returned but the camera readback does not match the bookmark. Inspect the active viewport before retrying."));
    }
    return FHaybaHandlerResult::Ok(Out);
}
