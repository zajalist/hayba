#include "HaybaMCPTextureHandler.h"
#include "HaybaMCPParams.h"

#include "Engine/Texture.h"
#include "Engine/Texture2D.h"
#include "UObject/SoftObjectPath.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Dom/JsonObject.h"
#include "UObject/Class.h"
#include "HaybaMCPReflection.h" // HaybaReflection::SetProp — generic UPROPERTY setter

TArray<FString> FHaybaMCPTextureHandler::GetCommands() const
{
    return {
        TEXT("texture_get_info"),
        TEXT("texture_set_compression"),
        TEXT("texture_set_settings"),
        TEXT("texture_list")
    };
}

static FString PixelFormatToString(EPixelFormat F)
{
    return GetPixelFormatString(F);
}

static FString CompressionToString(TextureCompressionSettings C)
{
    if (const UEnum* E = StaticEnum<TextureCompressionSettings>())
        return E->GetNameStringByValue((int64)C);
    return FString::FromInt((int32)C);
}

static FString LodGroupToString(TextureGroup G)
{
    if (const UEnum* E = StaticEnum<TextureGroup>())
        return E->GetNameStringByValue((int64)G);
    return FString::FromInt((int32)G);
}

static FString AddressToString(TextureAddress A)
{
    if (const UEnum* E = StaticEnum<TextureAddress>())
        return E->GetNameStringByValue((int64)A);
    return FString::FromInt((int32)A);
}

static FHaybaHandlerResult TexGetInfo(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("texture_get_info: missing params"));
    FString Path;
    FHaybaParamReader ParamR(P, TEXT("texture_get_info"));
    Path = ParamR.RequiredString(TEXT("path"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UTexture2D* Tex = Cast<UTexture2D>(FSoftObjectPath(Path).TryLoad());
    if (!Tex) return FHaybaHandlerResult::Err(FString::Printf(TEXT("texture_get_info: failed to load %s"), *Path));

    auto Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Path);
    Out->SetStringField(TEXT("name"), Tex->GetName());
    Out->SetNumberField(TEXT("width"),  Tex->GetSizeX());
    Out->SetNumberField(TEXT("height"), Tex->GetSizeY());

    EPixelFormat PF = PF_Unknown;
    int32 MipCount = 0;
    if (Tex->GetPlatformData())
    {
        PF = Tex->GetPlatformData()->PixelFormat;
        MipCount = Tex->GetPlatformData()->Mips.Num();
    }
    Out->SetStringField(TEXT("format"), PixelFormatToString(PF));
    Out->SetNumberField(TEXT("mip_count"), MipCount);
    Out->SetStringField(TEXT("compression_settings"), CompressionToString(Tex->CompressionSettings));
    Out->SetStringField(TEXT("lod_group"),  LodGroupToString(Tex->LODGroup));
    Out->SetBoolField  (TEXT("srgb"),       Tex->SRGB);
    Out->SetBoolField  (TEXT("never_stream"), Tex->NeverStream);
    Out->SetStringField(TEXT("address_x"),  AddressToString(Tex->AddressX));
    Out->SetStringField(TEXT("address_y"),  AddressToString(Tex->AddressY));

    return FHaybaHandlerResult::Ok(Out);
}

static FHaybaHandlerResult TexSetCompression(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("texture_set_compression: missing params"));
    FString Path;
    FHaybaParamReader ParamR(P, TEXT("texture_set_compression"));
    Path = ParamR.RequiredString(TEXT("path"));
    FString CompName;
    CompName = ParamR.RequiredString(TEXT("compression_settings"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UTexture2D* Tex = Cast<UTexture2D>(FSoftObjectPath(Path).TryLoad());
    if (!Tex) return FHaybaHandlerResult::Err(FString::Printf(TEXT("texture_set_compression: failed to load %s"), *Path));

#if WITH_EDITOR
    const UEnum* CEnum = StaticEnum<TextureCompressionSettings>();
    if (!CEnum) return FHaybaHandlerResult::Err(TEXT("texture_set_compression: enum lookup failed"));
    int64 CVal = CEnum->GetValueByNameString(CompName);
    if (CVal == INDEX_NONE)
    {
        // Try with TC_ prefix
        CVal = CEnum->GetValueByNameString(FString(TEXT("TC_")) + CompName);
        if (CVal == INDEX_NONE)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("texture_set_compression: unknown compression_settings '%s'"), *CompName));
    }

    Tex->Modify();
    Tex->CompressionSettings = (TextureCompressionSettings)CVal;

    FString LodGroupName;
    if (P->TryGetStringField(TEXT("lod_group"), LodGroupName))
    {
        if (const UEnum* LE = StaticEnum<TextureGroup>())
        {
            int64 LV = LE->GetValueByNameString(LodGroupName);
            if (LV == INDEX_NONE) LV = LE->GetValueByNameString(FString(TEXT("TEXTUREGROUP_")) + LodGroupName);
            if (LV != INDEX_NONE) Tex->LODGroup = (TextureGroup)LV;
        }
    }

    bool bSrgb = false;
    if (P->TryGetBoolField(TEXT("srgb"), bSrgb))
    {
        Tex->SRGB = bSrgb;
    }

    Tex->PostEditChange();
    Tex->UpdateResource();

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("path"), Path);
    Out->SetStringField(TEXT("compression_settings"), CompressionToString(Tex->CompressionSettings));
    Out->SetStringField(TEXT("lod_group"), LodGroupToString(Tex->LODGroup));
    Out->SetBoolField(TEXT("srgb"), Tex->SRGB);
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("texture_set_compression: editor-only command"));
#endif
}

// Generic texture-settings setter: set ANY UTexture/UTexture2D UPROPERTY by a
// `properties` map, so callers can change compression, mip-gen, max size,
// never-stream, filter, address modes, virtual texturing, lod bias, etc. in one
// call. Friendly snake_case aliases (matching texture_get_info output) map to the
// real UPROPERTY names; any other key is treated as a real UPROPERTY name.
static FHaybaHandlerResult TexSetSettings(const TSharedPtr<FJsonObject>& P)
{
    if (!P.IsValid()) return FHaybaHandlerResult::Err(TEXT("texture_set_settings: missing params"));
    FString Path;
    FHaybaParamReader ParamR(P, TEXT("texture_set_settings"));
    Path = ParamR.RequiredString(TEXT("path"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());
    const TSharedPtr<FJsonObject>* Props = nullptr;
    if (!P->TryGetObjectField(TEXT("properties"), Props) || !Props || (*Props)->Values.Num() == 0)
        return FHaybaHandlerResult::Err(TEXT("texture_set_settings: missing non-empty 'properties'"));

    UTexture2D* Tex = Cast<UTexture2D>(FSoftObjectPath(Path).TryLoad());
    if (!Tex) return FHaybaHandlerResult::Err(FString::Printf(TEXT("texture_set_settings: failed to load %s"), *Path));

#if WITH_EDITOR
    static const TMap<FString, FString> Aliases = {
        { TEXT("compression_settings"),      TEXT("CompressionSettings") },
        { TEXT("lod_group"),                 TEXT("LODGroup") },
        { TEXT("srgb"),                      TEXT("SRGB") },
        { TEXT("never_stream"),              TEXT("NeverStream") },
        { TEXT("address_x"),                 TEXT("AddressX") },
        { TEXT("address_y"),                 TEXT("AddressY") },
        { TEXT("mip_gen_settings"),          TEXT("MipGenSettings") },
        { TEXT("max_texture_size"),          TEXT("MaxTextureSize") },
        { TEXT("flip_green_channel"),        TEXT("bFlipGreenChannel") },
        { TEXT("filter"),                    TEXT("Filter") },
        { TEXT("virtual_texture_streaming"), TEXT("VirtualTextureStreaming") },
        { TEXT("lod_bias"),                  TEXT("LODBias") },
    };

    Tex->Modify();
    TArray<TSharedPtr<FJsonValue>> Applied;
    for (const auto& Pair : (*Props)->Values)
    {
        const FString Key = FString(*Pair.Key);
        const FString* Real = Aliases.Find(Key);
        const FString RealName = Real ? *Real : Key;
        if (HaybaReflection::SetProp(Tex, RealName, Pair.Value))
            Applied.Add(MakeShared<FJsonValueString>(Key));
    }
    Tex->PostEditChange();
    Tex->UpdateResource();

    auto Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), true);
    Out->SetStringField(TEXT("path"), Path);
    Out->SetArrayField(TEXT("applied"), Applied);
    Out->SetStringField(TEXT("compression_settings"), CompressionToString(Tex->CompressionSettings));
    Out->SetStringField(TEXT("lod_group"), LodGroupToString(Tex->LODGroup));
    Out->SetBoolField(TEXT("srgb"), Tex->SRGB);
    Out->SetBoolField(TEXT("never_stream"), Tex->NeverStream);
    return FHaybaHandlerResult::Ok(Out);
#else
    return FHaybaHandlerResult::Err(TEXT("texture_set_settings: editor-only command"));
#endif
}

static FHaybaHandlerResult TexList(const TSharedPtr<FJsonObject>& P)
{
    FString Prefix;
    if (P.IsValid()) P->TryGetStringField(TEXT("path_prefix"), Prefix);

    FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
    IAssetRegistry& AR = ARM.Get();

    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UTexture2D::StaticClass()->GetClassPathName(), Assets);

    TArray<TSharedPtr<FJsonValue>> Items;
    for (const FAssetData& A : Assets)
    {
        const FString ObjPath = A.GetObjectPathString();
        if (!Prefix.IsEmpty() && !ObjPath.StartsWith(Prefix)) continue;

        auto E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("path"), ObjPath);
        E->SetStringField(TEXT("name"), A.AssetName.ToString());

        // Pull width/height/format from asset tags without forcing a load.
        FString W, H, Fmt;
        A.GetTagValue(TEXT("Dimensions"), W); // sometimes "WxH"
        if (!W.IsEmpty())
        {
            FString WStr, HStr;
            if (W.Split(TEXT("x"), &WStr, &HStr))
            {
                E->SetNumberField(TEXT("width"),  FCString::Atoi(*WStr));
                E->SetNumberField(TEXT("height"), FCString::Atoi(*HStr));
            }
        }
        A.GetTagValue(TEXT("Format"), Fmt);
        if (!Fmt.IsEmpty()) E->SetStringField(TEXT("format"), Fmt);

        Items.Add(MakeShared<FJsonValueObject>(E));
    }

    auto Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("textures"), Items);
    Out->SetNumberField(TEXT("count"), Items.Num());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPTextureHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("texture_get_info"))         return TexGetInfo(Params);
    if (Cmd == TEXT("texture_set_compression"))  return TexSetCompression(Params);
    if (Cmd == TEXT("texture_set_settings"))     return TexSetSettings(Params);
    if (Cmd == TEXT("texture_list"))             return TexList(Params);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("TextureHandler: unknown command %s"), *Cmd));
}
