#include "HaybaMCPMetaSoundHandler.h"
#include "Json.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "MetasoundSource.h"
#include "Metasound.h"

#if WITH_EDITOR
#include "MetasoundFactory.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPMetaSound, Log, All);

TArray<FString> FHaybaMCPMetaSoundHandler::GetCommands() const
{
    return {
        TEXT("metasound_create"),
        TEXT("metasound_add_node"),
        TEXT("metasound_connect"),
        TEXT("metasound_set_input"),
        TEXT("metasound_compile"),
        TEXT("metasound_list")
    };
}

static FHaybaHandlerResult MSCreate(const TSharedPtr<FJsonObject>& P)
{
#if WITH_EDITOR
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("metasound_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMetaSoundSourceFactory* Factory = NewObject<UMetaSoundSourceFactory>();
    FString Dir = FPackageName::GetLongPackagePath(PkgPath);
    UObject* Created = Tools.CreateAsset(Name, Dir, UMetaSoundSource::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("metasound_create: CreateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetStringField(TEXT("class"), TEXT("MetaSoundSource"));
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("metasound_create: editor-only"));
#endif
}

static FHaybaHandlerResult MSList(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Path);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByPath(FName(*Path), Assets, /*Recursive*/true);

    const int32 Cap = 200;
    TArray<TSharedPtr<FJsonValue>> Out;
    bool bCapped = false;
    for (const FAssetData& A : Assets)
    {
        UClass* Cls = A.GetClass();
        if (!Cls) continue;
        const bool bIsSource = Cls->IsChildOf(UMetaSoundSource::StaticClass());
        const bool bIsPatch  = Cls->IsChildOf(UMetaSoundPatch::StaticClass());
        if (!bIsSource && !bIsPatch) continue;
        if (Out.Num() >= Cap) { bCapped = true; break; }

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  A.AssetName.ToString());
        Entry->SetStringField(TEXT("path"),  A.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("metasounds"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPMetaSoundHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("metasound_create")) return MSCreate(P);
    if (Cmd == TEXT("metasound_list"))   return MSList(P);

    // The MetaSoundFrontendDocumentBuilder API surface (node/edge/input mutation)
    // has shifted between UE 5.3/5.4/5.5/5.6/5.7 and lacks stable public signatures
    // for class-name-based node insertion, pin id resolution, and graph compile in 5.7.
    // Per issue #18 acceptance constraint, surface these as deferred rather than
    // fabricate function names.
    if (Cmd == TEXT("metasound_add_node"))
        return FHaybaHandlerResult::Err(TEXT("metasound_add_node: pending MetaSoundFrontendDocumentBuilder API stability"));
    if (Cmd == TEXT("metasound_connect"))
        return FHaybaHandlerResult::Err(TEXT("metasound_connect: pending MetaSoundFrontendDocumentBuilder API stability"));
    if (Cmd == TEXT("metasound_set_input"))
        return FHaybaHandlerResult::Err(TEXT("metasound_set_input: pending MetaSoundFrontendDocumentBuilder API stability"));
    if (Cmd == TEXT("metasound_compile"))
        return FHaybaHandlerResult::Err(TEXT("metasound_compile: pending MetaSoundFrontendDocumentBuilder API stability"));

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("MetaSoundHandler: unknown command %s"), *Cmd));
}
