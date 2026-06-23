#include "HaybaMCPLevelHandler.h"
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

static int32 SanitizeTransientStaticMeshRefs(UWorld* World, TArray<FString>& OutCleaned)
{
    if (!World) return 0;
    int32 Count = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* A = *It;
        if (!A) continue;
        TArray<UStaticMeshComponent*> Comps;
        A->GetComponents(Comps);
        for (UStaticMeshComponent* C : Comps)
        {
            if (!C) continue;
            UStaticMesh* SM = C->GetStaticMesh();
            if (SM && IsTransientPackageRef(SM))
            {
                C->Modify();
                C->SetStaticMesh(nullptr);
                OutCleaned.Add(FString::Printf(TEXT("%s.%s -> %s"), *A->GetName(), *C->GetName(), *SM->GetName()));
                ++Count;
            }
        }
    }
    return Count;
}

// File-static bookmark store — avoids adding state to the handler class.
static TMap<FString, FTransform> GHaybaBookmarkMap;

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
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("level_load: missing path"));

    bool bLoaded = FEditorFileUtils::LoadMap(Path, false, false);
    if (!bLoaded)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_load: LoadMap failed for path: %s"), *Path));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("loaded"), true);
    Out->SetStringField(TEXT("path"), Path);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_save
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSave(const TSharedPtr<FJsonObject>& P)
{
    // Strip dangling transient mesh refs (stale HLOD proxies) that would
    // otherwise fail the save with "Illegal reference to private object".
    TArray<FString> Cleaned;
    if (GEditor)
        if (UWorld* World = GEditor->GetEditorWorldContext().World())
            SanitizeTransientStaticMeshRefs(World, Cleaned);

    bool bSaved = FEditorFileUtils::SaveCurrentLevel();
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("saved"), bSaved);
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
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("level_create: missing path"));

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("level_create: GEditor is null"));

    GEditor->CreateNewMapForEditing(/*bPromptUserToSave=*/false);
    UWorld* World = GEditor->GetEditorWorldContext().World();
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("level_create: no editor world after CreateNewMapForEditing"));

    // Defensive: a freshly created map is clean, but if a template world is ever
    // used here, strip stale transient HLOD refs so the first save can't fail.
    TArray<FString> Cleaned;
    SanitizeTransientStaticMeshRefs(World, Cleaned);

    bool bSaved = FEditorFileUtils::SaveLevel(World->GetCurrentLevel(), *Path);
    if (!bSaved)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_create: SaveLevel failed for path: %s"), *Path));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("created"), true);
    Out->SetStringField(TEXT("path"), Path);
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
    FString Name;
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("level_set_bookmark: missing name"));

    FVector Location = FVector::ZeroVector;
    FRotator Rotation = FRotator::ZeroRotator;

    const TArray<TSharedPtr<FJsonValue>>* LocArr;
    if (P->TryGetArrayField(TEXT("location"), LocArr) && LocArr->Num() >= 3)
    {
        Location = FVector(
            (*LocArr)[0]->AsNumber(),
            (*LocArr)[1]->AsNumber(),
            (*LocArr)[2]->AsNumber());
    }
    else
    {
        // Use current viewport position
        if (GEditor)
        {
            FViewport* Viewport = GEditor->GetActiveViewport();
            if (Viewport)
            {
                FEditorViewportClient* VPC = static_cast<FEditorViewportClient*>(Viewport->GetClient());
                if (VPC)
                {
                    Location = VPC->GetViewLocation();
                    Rotation = VPC->GetViewRotation();
                }
            }
        }
    }

    FTransform T(Rotation, Location);
    GHaybaBookmarkMap.Add(Name, T);

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
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// level_goto_bookmark
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPLevelHandler::LevelGotoBookmark(const TSharedPtr<FJsonObject>& P)
{
    FString Name;
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("level_goto_bookmark: missing name"));

    const FTransform* T = GHaybaBookmarkMap.Find(Name);
    if (!T)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("level_goto_bookmark: bookmark not found: %s"), *Name));

    FVector Location = T->GetLocation();
    FRotator Rotation = T->Rotator();

    if (!GEditor)
        return FHaybaHandlerResult::Err(TEXT("level_goto_bookmark: editor not available"));

    FViewport* Viewport = GEditor->GetActiveViewport();
    if (Viewport)
    {
        FEditorViewportClient* VPC = static_cast<FEditorViewportClient*>(Viewport->GetClient());
        if (VPC)
        {
            VPC->SetViewLocation(Location);
            VPC->SetViewRotation(Rotation);
            VPC->Invalidate();
        }
    }

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
    return FHaybaHandlerResult::Ok(Out);
}
