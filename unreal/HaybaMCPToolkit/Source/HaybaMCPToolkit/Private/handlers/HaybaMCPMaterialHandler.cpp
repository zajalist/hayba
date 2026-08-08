#include "HaybaMCPMaterialHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Materials/Material.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/MaterialExpression.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/MaterialInstanceConstantFactoryNew.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "HaybaMCPAssetGuard.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/Actor.h"
#include "Engine/Texture.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UnrealType.h"
#include "UObject/EnumProperty.h"
// Graph authoring (Tasks 2-4): connections, node properties, material functions
#include "MaterialEditingLibrary.h"
#include "StaticParameterSet.h"  // FStaticParameterSet, FStaticSwitchParameter (Task 5)
#include "MaterialTypes.h"
#include "Materials/MaterialFunction.h"
#include "Factories/MaterialFunctionFactoryNew.h"
#include "Materials/MaterialExpressionParameter.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionStaticBoolParameter.h"
#include "Materials/MaterialExpressionStaticSwitchParameter.h"
#include "Materials/MaterialExpressionTextureBase.h"
#include "Materials/MaterialExpressionTextureSample.h"
#include "Materials/MaterialExpressionTextureSampleParameter.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant2Vector.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionConstant4Vector.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialExpressionFunctionInput.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionComment.h"
#include "Materials/MaterialExpressionNamedReroute.h"
#include "Materials/MaterialExpressionRerouteBase.h" // TraceInputsToRealExpression — graph validation
#include "HaybaMCPSeh.h"                              // SEH guard for fault-prone recompile/PostEditChange
#include "MaterialShared.h"  // FMaterialResource, GetCompileErrors (material_compile)
#include "MaterialStatsCommon.h" // FMaterialStatsUtils::ExtractMatertialStatsInfo (material_compile optimization feedback)
#include "MaterialStats.h"       // FShaderStatsInfo (MaterialEditor private; include path added in Build.cs)
#include "RHI.h"                 // GetExpectedFeatureLevelMaxTextureSamplers, GMaxRHIShaderPlatform
#include "UObject/SavePackage.h"
#include "HaybaMCPReflection.h"  // HaybaReflection::SetProp / SetStructField (generic, extracted from this handler)
#include "HaybaMCPParams.h"      // HaybaParams::GetString / GetNumber / GetBool / GetVec3

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPMaterial, Log, All);

TArray<FString> FHaybaMCPMaterialHandler::GetCommands() const
{
    return {
        TEXT("material_create"),
        TEXT("material_function_create"),
        TEXT("material_add_node"),
        TEXT("material_set_node"),
        TEXT("material_set_property"),
        TEXT("material_delete_node"),
        TEXT("material_add_comment"),
        TEXT("material_set_comment"),
        TEXT("material_delete_comment"),
        TEXT("material_add_reroute_declaration"),
        TEXT("material_add_reroute_usage"),
        TEXT("material_connect_nodes"),
        TEXT("material_compile"),
        TEXT("material_validate"),
        TEXT("material_create_instance"),
        TEXT("material_set_param"),
        TEXT("material_apply"),
        TEXT("material_list"),
        TEXT("material_get_info"),
        TEXT("material_disconnect"),
    };
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("material_create"))         return MatCreate(P);
    if (Cmd == TEXT("material_function_create")) return MatFunctionCreate(P);
    if (Cmd == TEXT("material_add_node"))       return MatAddNode(P);
    if (Cmd == TEXT("material_set_node"))       return MatSetNode(P);
    if (Cmd == TEXT("material_set_property"))   return MatSetProperty(P);
    if (Cmd == TEXT("material_delete_node"))    return MatDeleteNode(P);
    if (Cmd == TEXT("material_add_comment"))    return MatAddComment(P);
    if (Cmd == TEXT("material_set_comment"))    return MatSetComment(P);
    if (Cmd == TEXT("material_delete_comment")) return MatDeleteComment(P);
    if (Cmd == TEXT("material_add_reroute_declaration")) return MatAddRerouteDeclaration(P);
    if (Cmd == TEXT("material_add_reroute_usage"))       return MatAddRerouteUsage(P);
    if (Cmd == TEXT("material_connect_nodes"))  return MatConnectNodes(P);
    if (Cmd == TEXT("material_compile"))        return MatCompile(P);
    if (Cmd == TEXT("material_validate"))       return MatValidate(P);
    if (Cmd == TEXT("material_create_instance")) return MatCreateInstance(P);
    if (Cmd == TEXT("material_set_param"))      return MatSetParam(P);
    if (Cmd == TEXT("material_apply"))          return MatApply(P);
    if (Cmd == TEXT("material_list"))           return MatList(P);
    if (Cmd == TEXT("material_get_info"))       return MatGetInfo(P);
    if (Cmd == TEXT("material_disconnect"))     return MatDisconnect(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("MaterialHandler: unknown command %s"), *Cmd));
}

static AActor* FindActorInWorld(UWorld* World, const FString& Name)
{
    if (!World) return nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
        if ((*It)->GetName() == Name) return *It;
    return nullptr;
}

static UMaterialExpression* FindExprByName(UMaterial* Mat, const FString& NodeId)
{
    if (!Mat) return nullptr;
    for (UMaterialExpression* E : Mat->GetExpressions())
        if (E && E->GetName() == NodeId) return E;
    return nullptr;
}

static UMaterialExpression* FindExprByNameInFunction(UMaterialFunction* Fn, const FString& NodeId)
{
    if (!Fn) return nullptr;
    for (UMaterialExpression* E : Fn->GetExpressions())
        if (E && E->GetName() == NodeId) return E;
    return nullptr;
}

// Crash-resilient persistence (decision 2026-06-22). Per-edit handlers no
// longer force a synchronous UMaterialEditingLibrary::RecompileMaterial — that
// translates the (possibly half-built) graph through the HLSL translator, which
// asserts (e.g. "NormalCodeChunk != INDEX_NONE") and takes the whole editor
// down on an invalid intermediate graph. Instead each successful edit marks the
// package dirty and writes it to disk immediately, so the AI's progress
// survives a later crash. The expensive/assert-prone translate is deferred to
// the explicit, guarded material_compile command.
//
// NOTE: saving a UMaterial can still trigger shader translation internally; the
// real assert-avoidance is that routine per-edit translates are gone. A truly
// pathological graph can still assert when explicitly compiled — that is an
// engine-level check() we cannot catch from here. Returns false + reason on
// save failure; never throws.
static bool HaybaPersistAsset(UObject* Asset, FString& OutError)
{
    if (!Asset) { OutError = TEXT("null asset"); return false; }
    Asset->MarkPackageDirty();
    UPackage* Pkg = Asset->GetOutermost();
    if (!Pkg) { OutError = TEXT("no package"); return false; }

    const FString FileName = FPackageName::LongPackageNameToFilename(
        Pkg->GetName(), FPackageName::GetAssetPackageExtension());

    FSavePackageArgs Args;
    Args.TopLevelFlags = RF_Public | RF_Standalone;
    Args.SaveFlags = SAVE_NoError;
    const bool bOk = UPackage::SavePackage(Pkg, nullptr, *FileName, Args);
    if (!bOk)
    {
        OutError = FString::Printf(TEXT("SavePackage failed for %s"), *Pkg->GetName());
        return false;
    }
    return true;
}

static bool TryParseProperty(const FString& In, EMaterialProperty& Out)
{
    const FString S = In.ToLower();
    if (S == TEXT("base_color"))            { Out = MP_BaseColor; return true; }
    if (S == TEXT("metallic"))              { Out = MP_Metallic; return true; }
    if (S == TEXT("specular"))              { Out = MP_Specular; return true; }
    if (S == TEXT("roughness"))             { Out = MP_Roughness; return true; }
    if (S == TEXT("emissive"))              { Out = MP_EmissiveColor; return true; }
    if (S == TEXT("opacity"))               { Out = MP_Opacity; return true; }
    if (S == TEXT("opacity_mask"))          { Out = MP_OpacityMask; return true; }
    if (S == TEXT("normal"))                { Out = MP_Normal; return true; }
    if (S == TEXT("world_position_offset")) { Out = MP_WorldPositionOffset; return true; }
    if (S == TEXT("ambient_occlusion"))     { Out = MP_AmbientOcclusion; return true; }
    if (S == TEXT("subsurface"))            { Out = MP_SubsurfaceColor; return true; }
    // Task 2: extended connectable outputs
    if (S == TEXT("pixel_depth_offset"))    { Out = MP_PixelDepthOffset; return true; }
    if (S == TEXT("refraction"))            { Out = MP_Refraction; return true; }
    if (S == TEXT("clear_coat"))            { Out = MP_CustomData0; return true; }
    if (S == TEXT("clear_coat_roughness"))  { Out = MP_CustomData1; return true; }
    if (S == TEXT("custom_data_0"))         { Out = MP_CustomData0; return true; }
    if (S == TEXT("custom_data_1"))         { Out = MP_CustomData1; return true; }
    if (S == TEXT("anisotropy"))            { Out = MP_Anisotropy; return true; }
    if (S == TEXT("tangent"))               { Out = MP_Tangent; return true; }
    if (S == TEXT("shading_model_from_node")) { Out = MP_ShadingModel; return true; }
    // Substrate (from fix/ci-test-suite-green)
    if (S == TEXT("front_material"))        { Out = MP_FrontMaterial; return true; }
    if (S == TEXT("displacement"))          { Out = MP_Displacement; return true; }  // Nanite tessellation (needs material_set_property enable_tessellation=true)
    return false;
}

// Outcome of ApplyNodeProps: which requested keys actually took (Applied) and which
// did NOT (Unknown = friendly alias that hit a non-matching node type, OR a reflection
// key with no matching UPROPERTY / a set that failed). Lets material_add_node /
// material_set_node report a mistyped key loudly instead of silently no-op'ing.
struct FApplyNodePropsResult
{
    TArray<FString> Applied;
    TArray<FString> Unknown;
};

// Apply optional per-node properties. Friendly aliases (parameter_name/default_value/
// texture/const/function/coordinate_index/u_tiling/v_tiling) are handled first for
// back-compat; every other key is treated as a real UPROPERTY name and set via
// reflection (HaybaReflection::SetProp) — so callers can set InputType, ComponentMask
// R/G/B/A, SortPriority, SamplerType, Desc, etc. with no per-type code here.
// Returns which requested keys applied vs were unknown/no-op (see FApplyNodePropsResult).
static FApplyNodePropsResult ApplyNodeProps(UMaterialExpression* Expr, const TSharedPtr<FJsonObject>& Props)
{
    FApplyNodePropsResult R;
    if (!Expr || !Props.IsValid()) return R;

    // Record an alias key that was present in Props: Applied if it stuck on this
    // node type, otherwise Unknown (so `default_value` on a non-parameter, etc.,
    // is reported rather than silently swallowed).
    auto RecordAlias = [&](const TCHAR* Key, bool bApplied)
    {
        if (Props->HasField(Key))
            (bApplied ? R.Applied : R.Unknown).Add(FString(Key));
    };

    // parameter_name binds Parameter/TextureSampleParameter names AND (Task 4)
    // FunctionInput/FunctionOutput names — any one of these counts as applied.
    FString S;
    bool bParamNameApplied = false;
    if (Props->TryGetStringField(TEXT("parameter_name"), S))
    {
        const FName PName(*S);
        if (UMaterialExpressionParameter* Par = Cast<UMaterialExpressionParameter>(Expr)) { Par->ParameterName = PName; bParamNameApplied = true; }
        if (UMaterialExpressionTextureSampleParameter* Tp = Cast<UMaterialExpressionTextureSampleParameter>(Expr)) { Tp->ParameterName = PName; bParamNameApplied = true; }
        if (UMaterialExpressionFunctionInput* In = Cast<UMaterialExpressionFunctionInput>(Expr)) { In->InputName = PName; bParamNameApplied = true; }
        if (UMaterialExpressionFunctionOutput* O = Cast<UMaterialExpressionFunctionOutput>(Expr)) { O->OutputName = PName; bParamNameApplied = true; }
    }
    RecordAlias(TEXT("parameter_name"), bParamNameApplied);

    bool bDefaultApplied = false;
    const TSharedPtr<FJsonValue> DV = Props->TryGetField(TEXT("default_value"));
    if (DV.IsValid())
    {
        if (UMaterialExpressionScalarParameter* Sc = Cast<UMaterialExpressionScalarParameter>(Expr); Sc && DV->Type == EJson::Number)
            { Sc->DefaultValue = (float)DV->AsNumber(); bDefaultApplied = true; }
        if (UMaterialExpressionStaticBoolParameter* Sb = Cast<UMaterialExpressionStaticBoolParameter>(Expr); Sb && DV->Type == EJson::Boolean)
            { Sb->DefaultValue = DV->AsBool(); bDefaultApplied = true; }
        if (UMaterialExpressionVectorParameter* Vp = Cast<UMaterialExpressionVectorParameter>(Expr); Vp && DV->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = DV->AsArray();
            FLinearColor C(0, 0, 0, 1);
            if (A.Num() > 0) C.R = A[0]->AsNumber();
            if (A.Num() > 1) C.G = A[1]->AsNumber();
            if (A.Num() > 2) C.B = A[2]->AsNumber();
            if (A.Num() > 3) C.A = A[3]->AsNumber();
            Vp->DefaultValue = C; bDefaultApplied = true;
        }
    }
    RecordAlias(TEXT("default_value"), bDefaultApplied);

    bool bTexApplied = false;
    FString TexPath;
    if (Props->TryGetStringField(TEXT("texture"), TexPath))
        if (UMaterialExpressionTextureBase* Ts = Cast<UMaterialExpressionTextureBase>(Expr))
            if (UTexture* Tex = LoadObject<UTexture>(nullptr, *TexPath)) { Ts->Texture = Tex; bTexApplied = true; }
    RecordAlias(TEXT("texture"), bTexApplied);

    bool bConstApplied = false;
    const TSharedPtr<FJsonValue> CV = Props->TryGetField(TEXT("const"));
    if (CV.IsValid())
    {
        if (UMaterialExpressionConstant* C1 = Cast<UMaterialExpressionConstant>(Expr); C1 && CV->Type == EJson::Number)
            { C1->R = (float)CV->AsNumber(); bConstApplied = true; }
        if (CV->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = CV->AsArray();
            auto N = [&A](int32 i) { return A.IsValidIndex(i) ? (float)A[i]->AsNumber() : 0.f; };
            if (UMaterialExpressionConstant2Vector* C2 = Cast<UMaterialExpressionConstant2Vector>(Expr)) { C2->R = N(0); C2->G = N(1); bConstApplied = true; }
            if (UMaterialExpressionConstant3Vector* C3 = Cast<UMaterialExpressionConstant3Vector>(Expr)) { C3->Constant = FLinearColor(N(0), N(1), N(2), 1.f); bConstApplied = true; }
            if (UMaterialExpressionConstant4Vector* C4 = Cast<UMaterialExpressionConstant4Vector>(Expr)) { C4->Constant = FLinearColor(N(0), N(1), N(2), N(3)); bConstApplied = true; }
        }
    }
    RecordAlias(TEXT("const"), bConstApplied);

    bool bFuncApplied = false;
    FString FuncPath;
    if (!Props->TryGetStringField(TEXT("function"), FuncPath))
        Props->TryGetStringField(TEXT("function_path"), FuncPath); // accept either key
    if (!FuncPath.IsEmpty())
        if (UMaterialExpressionMaterialFunctionCall* Fc = Cast<UMaterialExpressionMaterialFunctionCall>(Expr))
            if (UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath))
            {
                Fc->SetMaterialFunction(Fn);
                // CRITICAL: rebuild FunctionInputs/FunctionOutputs now. Without this
                // the call's pins stay empty until the editor opens/recompiles, so
                // connect-by-name (and material_get_info.outputs[]) see nothing —
                // the exact footgun that drove the recompile/find_object dances in
                // the python_run traces.
                Fc->UpdateFromFunctionResource();
                bFuncApplied = true;
            }
    // `function` is the alias; `function_path` is accepted as a synonym — record
    // whichever the caller supplied.
    RecordAlias(TEXT("function"), bFuncApplied);
    if (Props->HasField(TEXT("function_path")))
        (bFuncApplied ? R.Applied : R.Unknown).Add(TEXT("function_path"));

    bool bCoordApplied = false;
    if (UMaterialExpressionTextureCoordinate* Tc = Cast<UMaterialExpressionTextureCoordinate>(Expr))
    {
        double D;
        if (Props->TryGetNumberField(TEXT("coordinate_index"), D)) { Tc->CoordinateIndex = (int32)D; }
        if (Props->TryGetNumberField(TEXT("u_tiling"), D)) { Tc->UTiling = (float)D; }
        if (Props->TryGetNumberField(TEXT("v_tiling"), D)) { Tc->VTiling = (float)D; }
        bCoordApplied = true;
    }
    RecordAlias(TEXT("coordinate_index"), bCoordApplied);
    RecordAlias(TEXT("u_tiling"), bCoordApplied);
    RecordAlias(TEXT("v_tiling"), bCoordApplied);

    // Generic reflection passthrough: any key that isn't a friendly alias is
    // treated as a real UPROPERTY name (e.g. InputType, R/G/B/A, SortPriority,
    // SamplerType, ConstCoordinate, Desc). HaybaReflection::SetProp returns false
    // when the class has no such FProperty (a mistyped/invalid key) — collect
    // those as Unknown so callers hear about the no-op instead of a silent success.
    static const TSet<FString> Aliases = {
        TEXT("parameter_name"), TEXT("default_value"), TEXT("texture"),
        TEXT("const"), TEXT("function"), TEXT("function_path"),
        TEXT("coordinate_index"), TEXT("u_tiling"), TEXT("v_tiling"),
    };
    for (const auto& Pair : Props->Values)
    {
        const FString Key = FString(*Pair.Key);
        if (Aliases.Contains(Key)) continue;
        if (HaybaReflection::SetProp(Expr, Key, Pair.Value)) R.Applied.Add(Key);
        else                                                 R.Unknown.Add(Key);
    }

    Expr->PostEditChange();
    return R;
}

// A few real, editable UPROPERTY names on this expression's class — a hint returned
// alongside unknown_props so a caller who mistyped a key can see valid options.
static TArray<FString> HaybaListNodeProps(UMaterialExpression* Expr, int32 Max = 12)
{
    TArray<FString> Names;
    if (!Expr) return Names;
    for (TFieldIterator<FProperty> It(Expr->GetClass()); It && Names.Num() < Max; ++It)
        if (It->HasAnyPropertyFlags(CPF_Edit))
            Names.Add(It->GetName());
    return Names;
}

// Attach applied_props/unknown_props (and, when there were unknowns, a valid_props
// hint + data-level ok:false + warning) to a node handler's result payload.
// NOTE: we deliberately keep the HANDLER envelope ok:true even when a key is
// unknown, because material_add_node is a registered destructive command — the
// command router CANCELS the transaction on bOk=false (HaybaMCPCommandHandler
// ~L926), which would UNDO the just-created node. Returning ok:true preserves the
// node while the data-level ok:false + unknown_props[] + warning make the
// partial failure loud and machine-readable (matches the "no silent success" bar).
static void AttachNodePropsResult(const TSharedRef<FJsonObject>& Out,
                                  const FApplyNodePropsResult& PR,
                                  UMaterialExpression* Expr,
                                  const TCHAR* Cmd)
{
    TArray<TSharedPtr<FJsonValue>> Applied;
    for (const FString& K : PR.Applied) Applied.Add(MakeShared<FJsonValueString>(K));
    Out->SetArrayField(TEXT("applied_props"), Applied);

    TArray<TSharedPtr<FJsonValue>> Unknown;
    for (const FString& K : PR.Unknown) Unknown.Add(MakeShared<FJsonValueString>(K));
    Out->SetArrayField(TEXT("unknown_props"), Unknown);

    if (PR.Unknown.Num() > 0)
    {
        const TArray<FString> Valid = HaybaListNodeProps(Expr);
        TArray<TSharedPtr<FJsonValue>> ValidJson;
        for (const FString& K : Valid) ValidJson.Add(MakeShared<FJsonValueString>(K));
        Out->SetArrayField(TEXT("valid_props"), ValidJson);

        Out->SetBoolField(TEXT("ok"), false);
        Out->SetStringField(TEXT("warning"), FString::Printf(
            TEXT("%s: %d property key(s) did not apply to node '%s' (%s) and were ignored: [%s]. Check spelling/casing against valid_props."),
            Cmd, PR.Unknown.Num(),
            *(Out->HasField(TEXT("node_id")) ? Out->GetStringField(TEXT("node_id")) : FString(TEXT("?"))),
            *Expr->GetClass()->GetName(), *FString::Join(PR.Unknown, TEXT(", "))));
    }
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCreate(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!HaybaParams::GetString(P, TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_create: missing package_path"));
    if (!HaybaParams::GetString(P, TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
    // package_path may be the target directory OR the full asset path — see
    // material_function_create for the rationale. Backward-compatible: when the
    // last segment already equals Name (the documented full-path convention) this
    // strips it exactly as before; a bare directory now lands correctly too.
    const FString Dir = (FPackageName::GetShortName(PkgPath) == Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_create"), Dir, Name));
    }

    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterial::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_create: CreateAsset failed"));

    // Persist immediately: CreateAsset only makes the asset in memory, so a
    // crash (or session end) before the first edit would lose it and later
    // material_get_info would report "no UMaterial at path".
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Created, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatFunctionCreate(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!HaybaParams::GetString(P, TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_function_create: missing package_path"));
    if (!HaybaParams::GetString(P, TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_function_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFunctionFactoryNew* Factory = NewObject<UMaterialFunctionFactoryNew>();
    // Robust path resolution — package_path may be EITHER the target directory
    // ("/Game/Dir/MFs") OR the full asset path ("/Game/Dir/MFs/MF_X"). Historically
    // this always did GetLongPackagePath (drops the last segment), which silently
    // landed the asset one folder UP when a directory was passed. Detect which the
    // caller supplied by comparing the last path segment to Name:
    //   last segment == Name  -> full asset path -> Dir = parent (drop the name)
    //   otherwise             -> directory       -> Dir = package_path (keep as-is)
    const FString ShortName = FPackageName::GetShortName(PkgPath); // last segment after final '/'
    const FString Dir = (ShortName == Name)
        ? FPackageName::GetLongPackagePath(PkgPath)  // full path: strip the trailing name
        : PkgPath;                                   // directory: use verbatim
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_function_create"), Dir, Name));
    }

    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterialFunction::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_function_create: CreateAsset failed"));

    // Persist immediately (see material_create) so the function survives a crash
    // before its first edit.
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Created, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

// Spread auto-placed nodes (no explicit node_pos) over a grid keyed off the
// count of existing expressions, instead of stacking every new node at (0,0).
// Inputs flow left->right toward the output, so new nodes start far left and
// wrap into rows. Explicit node_pos always overrides this.
static void HaybaAutoNodePos(int32 ExistingCount, int32& X, int32& Y)
{
    // Spacing must clear the LARGEST common nodes (a TextureSample draws a live
    // preview thumbnail ~256x256 plus pins/labels), so generous gaps — the old
    // 320x260 grid overlapped texture samples badly. 5 columns keeps the block
    // from sprawling too wide while feeding rightward into the output node at ~0,0.
    constexpr int32 Cols = 5;
    constexpr int32 DX = 480;   // horizontal spacing (clears widest node + pins/labels)
    constexpr int32 DY = 420;   // vertical spacing (clears a texture-sample preview)
    constexpr int32 OriginX = -2500;
    constexpr int32 OriginY = -800;
    X = OriginX + (ExistingCount % Cols) * DX;
    Y = OriginY + (ExistingCount / Cols) * DY;
}

// When a newly-added node is a MaterialFunctionCall, emit its (now-rebuilt)
// output pins so the caller can wire from_output by name immediately — no
// follow-up material_get_info, no recompile dance.
static void EmitFunctionCallOutputs(UMaterialExpression* Expr, const TSharedRef<FJsonObject>& Out)
{
    UMaterialExpressionMaterialFunctionCall* Fc = Cast<UMaterialExpressionMaterialFunctionCall>(Expr);
    if (!Fc) return;
    TArray<TSharedPtr<FJsonValue>> Outs;
    for (int32 i = 0; i < Fc->FunctionOutputs.Num(); ++i)
    {
        TSharedPtr<FJsonObject> O = MakeShared<FJsonObject>();
        O->SetStringField(TEXT("name"), Fc->FunctionOutputs[i].Output.OutputName.ToString());
        O->SetNumberField(TEXT("index"), i);
        Outs.Add(MakeShared<FJsonValueObject>(O.ToSharedRef()));
    }
    Out->SetArrayField(TEXT("outputs"), Outs);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString ExprClass;
    FHaybaParamReader ParamR(P, TEXT("material_add_node"));
    ExprClass = ParamR.RequiredString(TEXT("expression_class"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UClass* ExprCls = FindFirstObjectSafe<UClass>(*ExprClass);
    if (!ExprCls) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_node: class not found: %s"), *ExprClass));

    int32 X = 0, Y = 0;
    bool bHasPos = false;
    const TArray<TSharedPtr<FJsonValue>>* Pos;
    if (P->TryGetArrayField(TEXT("node_pos"), Pos) && Pos->Num() >= 2)
    {
        X = (int32)(*Pos)[0]->AsNumber();
        Y = (int32)(*Pos)[1]->AsNumber();
        bHasPos = true;
    }

    const TSharedPtr<FJsonObject>* PropsObj = nullptr;
    P->TryGetObjectField(TEXT("properties"), PropsObj);

    // Material-Function target (Task 4) takes precedence when supplied.
    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_node: function not found"));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, ExprCls, X, Y);
        if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpressionInFunction failed"));
        FApplyNodePropsResult PR;
        if (PropsObj) PR = ApplyNodeProps(Expr, *PropsObj);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), Expr->GetName());
        EmitFunctionCallOutputs(Expr, Out.ToSharedRef());
        AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_add_node"));
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_node: missing material_path or function_path"));

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_node: material not found"));

    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpression(Mat, ExprCls, X, Y);
    if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpression failed"));
    FApplyNodePropsResult PR;
    if (PropsObj) PR = ApplyNodeProps(Expr, *PropsObj);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), Expr->GetName());
    EmitFunctionCallOutputs(Expr, Out.ToSharedRef());
    AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_add_node"));
    return FHaybaHandlerResult::Ok(Out);
}

// Count how many expression inputs across the graph read From's output (node->node
// fan-out). Property outputs (base_color etc.) are added by the caller.
static int32 CountSourceFanout(UMaterial* Mat, UMaterialExpression* From)
{
    if (!Mat || !From) return 0;
    int32 N = 0;
    for (UMaterialExpression* E : Mat->GetExpressions())
    {
        if (!E) continue;
        for (FExpressionInputIterator It{E}; It; ++It)
            if (It->Expression == From) ++N;
    }
    return N;
}

// Heuristic: does the straight wire From.output -> To.input pass OVER another
// node's box (spaghetti / wire crossing a node)? Sampled along the segment vs an
// approximate per-node box anchored at the editor position. Also flags a wire
// that runs backward (To left of From) as spaghetti-prone.
static bool WireLooksLikeSpaghetti(UMaterial* Mat, UMaterialExpression* From, UMaterialExpression* To)
{
    if (!Mat || !From || !To) return false;
    constexpr float NodeW = 280.f, NodeH = 220.f;
    if (To->MaterialExpressionEditorX < From->MaterialExpressionEditorX) return true; // backward wire
    const float Ax = From->MaterialExpressionEditorX + NodeW, Ay = From->MaterialExpressionEditorY + 40.f;
    const float Bx = (float)To->MaterialExpressionEditorX,    By = To->MaterialExpressionEditorY + 40.f;
    for (UMaterialExpression* E : Mat->GetExpressions())
    {
        if (!E || E == From || E == To) continue;
        const float Ex = (float)E->MaterialExpressionEditorX, Ey = (float)E->MaterialExpressionEditorY;
        for (int32 i = 1; i < 24; ++i)
        {
            const float t = (float)i / 24.f;
            const float Px = Ax + (Bx - Ax) * t, Py = Ay + (By - Ay) * t;
            if (Px >= Ex && Px <= Ex + NodeW && Py >= Ey && Py <= Ey + NodeH) return true;
        }
    }
    return false;
}

// A source node with >1 output (most importantly a MaterialFunctionCall) MUST
// have its output pin chosen explicitly — otherwise both the name path
// (ConnectMaterialExpressions with "") and the index path (FromOutputIndex=0)
// silently default to the FIRST output, which mis-wires/swaps function outputs
// (e.g. Albedo and F0 ending up crossed). Refuse and list the real pins.
static bool RequireOutputChoice(UMaterialExpression* From, const FString& FromOutput, bool bHasFromOutputIndex, FString& OutErr)
{
    if (!From) return true;
    const TArray<FExpressionOutput>& Outs = From->GetOutputs();
    if (Outs.Num() <= 1) return true;                 // unambiguous
    if (!FromOutput.IsEmpty() || bHasFromOutputIndex) return true; // caller chose
    TArray<FString> Names;
    for (int32 i = 0; i < Outs.Num(); ++i)
        Names.Add(FString::Printf(TEXT("[%d] %s"), i,
            Outs[i].OutputName.IsNone() ? TEXT("(unnamed)") : *Outs[i].OutputName.ToString()));
    OutErr = FString::Printf(
        TEXT("material_connect_nodes: '%s' has %d outputs (%s) — specify which with from_output (the pin NAME) or from_output_index. Defaulting to the first output silently swaps multi-output nodes like material functions."),
        *From->GetName(), Outs.Num(), *FString::Join(Names, TEXT(", ")));
    return false;
}

// Resolve from_output (name or explicit index) to a concrete output index —
// AUTHORITATIVELY, so the name path can never silently fall back to output 0.
// UMaterialEditingLibrary::ConnectMaterialExpressions matches the from-output by
// name only against GetOutputs().OutputName, which for a MaterialFunctionCall can
// be empty/stale — so "Normal" silently connected output 0 (the reported bug).
// We match GetOutputs().OutputName first, then the call's authoritative
// FunctionOutputs[i].Output.OutputName, and return INDEX_NONE (caller errors)
// rather than guessing.
static int32 ResolveFromOutputIndex(UMaterialExpression* From, const FString& Name, bool bHasIdx, int32 Idx, FString& OutErr)
{
    const TArray<FExpressionOutput>& Outs = From->GetOutputs();
    if (bHasIdx)
    {
        if (Idx >= 0 && Idx < Outs.Num()) return Idx;
        OutErr = FString::Printf(TEXT("from_output_index %d out of range (%d outputs)"), Idx, Outs.Num());
        return INDEX_NONE;
    }
    if (Name.IsEmpty()) return 0; // single-output; multi-output already gated by RequireOutputChoice
    for (int32 i = 0; i < Outs.Num(); ++i)
        if (Outs[i].OutputName.ToString().Equals(Name, ESearchCase::IgnoreCase)) return i;
    if (UMaterialExpressionMaterialFunctionCall* Call = Cast<UMaterialExpressionMaterialFunctionCall>(From))
        for (int32 i = 0; i < Call->FunctionOutputs.Num(); ++i)
            if (Call->FunctionOutputs[i].Output.OutputName.ToString().Equals(Name, ESearchCase::IgnoreCase)) return i;
    TArray<FString> Avail;
    for (int32 i = 0; i < Outs.Num(); ++i)
    {
        FString Nm = Outs[i].OutputName.IsNone() ? FString() : Outs[i].OutputName.ToString();
        if (Nm.IsEmpty())
            if (UMaterialExpressionMaterialFunctionCall* C = Cast<UMaterialExpressionMaterialFunctionCall>(From))
                if (C->FunctionOutputs.IsValidIndex(i)) Nm = C->FunctionOutputs[i].Output.OutputName.ToString();
        Avail.Add(FString::Printf(TEXT("[%d] %s"), i, Nm.IsEmpty() ? TEXT("(unnamed)") : *Nm));
    }
    OutErr = FString::Printf(TEXT("from_output '%s' not found on '%s' — available outputs: %s. (Use the exact name or from_output_index.)"),
        *Name, *From->GetName(), *FString::Join(Avail, TEXT(", ")));
    return INDEX_NONE;
}

// Resolve the target input to a concrete FExpressionInput* (by index, then by
// pin name, else first). Returns null when a named/indexed input doesn't exist.
static FExpressionInput* ResolveToInput(UMaterialExpression* To, const FString& ToInputName, int32 ToInputIndex)
{
    if (ToInputIndex >= 0) return To->GetInput(ToInputIndex);
    if (!ToInputName.IsEmpty())
    {
        const int32 N = To->CountInputs();
        for (int32 i = 0; i < N; ++i)
        {
            FExpressionInput* In = To->GetInput(i);
            const FName Rn = To->GetInputName(i);
            const FString Nm = !Rn.IsNone() ? Rn.ToString()
                : (In && !In->InputName.IsNone() ? In->InputName.ToString() : FString());
            if (Nm.Equals(ToInputName, ESearchCase::IgnoreCase)) return In;
        }
        return nullptr;
    }
    return To->GetInput(0);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatConnectNodes(const TSharedPtr<FJsonObject>& P)
{
    FString FromNode;
    FHaybaParamReader ParamR(P, TEXT("material_connect_nodes"));
    FromNode = ParamR.RequiredString(TEXT("from_node"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    FString FromOutput;
    P->TryGetStringField(TEXT("from_output"), FromOutput); // "" => first output

    FString ToNode, ToInput, PropStr;
    const bool bHasTo = P->TryGetStringField(TEXT("to_node"), ToNode);
    P->TryGetStringField(TEXT("to_input"), ToInput);       // "" => first input
    const bool bHasProp = P->TryGetStringField(TEXT("to_property"), PropStr);

    // Index-based connection for pins that have no addressable name (Substrate
    // slab/operator inputs report as input_N). to_input_index targets the Nth
    // input; from_output_index picks the source output (default 0).
    int32 ToInputIndex = -1, FromOutputIndex = 0;
    bool bHasFromOutputIndex = false;
    { double D; if (P->TryGetNumberField(TEXT("to_input_index"), D)) ToInputIndex = (int32)D; }
    { double D; if (P->TryGetNumberField(TEXT("from_output_index"), D)) { FromOutputIndex = (int32)D; bHasFromOutputIndex = true; } }

    // Material-Function target (Task 4).
    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: function not found"));
        UMaterialExpression* From = FindExprByNameInFunction(Fn, FromNode);
        if (!From) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: from_node not found: %s"), *FromNode));
        { FString OutErr; if (!RequireOutputChoice(From, FromOutput, bHasFromOutputIndex, OutErr)) return FHaybaHandlerResult::Err(OutErr); }
        if (!bHasTo) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: function connections require to_node"));
        UMaterialExpression* To = FindExprByNameInFunction(Fn, ToNode);
        if (!To) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_node not found: %s"), *ToNode));
        {
            FString OErr;
            const int32 FromIdx = ResolveFromOutputIndex(From, FromOutput, bHasFromOutputIndex, FromOutputIndex, OErr);
            if (FromIdx == INDEX_NONE) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: %s"), *OErr));
            FExpressionInput* In = ResolveToInput(To, ToInput, ToInputIndex);
            if (!In) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_input '%s' (index %d) not found on '%s'"), *ToInput, ToInputIndex, *ToNode));
            In->Connect(FromIdx, From); // index-resolved — never silently output 0
        }
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("connected"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: material not found"));

    UMaterialExpression* From = FindExprByName(Mat, FromNode);
    if (!From) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: from_node not found: %s"), *FromNode));
    { FString OutErr; if (!RequireOutputChoice(From, FromOutput, bHasFromOutputIndex, OutErr)) return FHaybaHandlerResult::Err(OutErr); }

    // Resolve the source output index once (authoritative; never silent-0).
    FString FromIdxErr;
    const int32 FromIdx = ResolveFromOutputIndex(From, FromOutput, bHasFromOutputIndex, FromOutputIndex, FromIdxErr);
    if (FromIdx == INDEX_NONE) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: %s"), *FromIdxErr));

    UMaterialExpression* To = nullptr;  // null when connecting to a material property
    if (bHasProp)
    {
        EMaterialProperty Prop;
        if (!TryParseProperty(PropStr, Prop))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: unknown to_property: %s"), *PropStr));
        FExpressionInput* In = Mat->GetExpressionInputForProperty(Prop);
        if (!In) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: material property '%s' has no input (material attributes in use?)"), *PropStr));
        In->Connect(FromIdx, From); // index-resolved — never silently output 0
    }
    else
    {
        if (!bHasTo) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing to_node or to_property"));
        To = FindExprByName(Mat, ToNode);
        if (!To) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_node not found: %s"), *ToNode));
        FExpressionInput* In = ResolveToInput(To, ToInput, ToInputIndex);
        if (!In) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_input '%s' (index %d) not found on '%s'"), *ToInput, ToInputIndex, *ToNode));
        In->Connect(FromIdx, From); // index-resolved — never silently output 0
    }

    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("connected"), true);

    // ── Clutter prevention (non-binding hints) ────────────────────────────────
    TArray<TSharedPtr<FJsonValue>> Suggestions;
    const int32 Fanout = CountSourceFanout(Mat, From) + (bHasProp ? 1 : 0);
    if (Fanout >= 2)
    {
        Out->SetNumberField(TEXT("from_node_fanout"), Fanout);
        Suggestions.Add(MakeShared<FJsonValueString>(FString::Printf(
            TEXT("'%s' now feeds %d places. Cut wire clutter with a NAMED REROUTE: material_add_reroute_declaration on '%s' once, then material_add_reroute_usage at EACH target (copy one per output) instead of long fan-out wires."),
            *FromNode, Fanout, *FromNode)));
    }
    if (To && WireLooksLikeSpaghetti(Mat, From, To))
    {
        Suggestions.Add(MakeShared<FJsonValueString>(FString::Printf(
            TEXT("the wire '%s'->'%s' runs backward or crosses over another node (spaghetti). Insert a REROUTE knee node (material_add_node expression_class=\"MaterialExpressionReroute\") between them at a clear position to redirect the wire around the obstruction."),
            *FromNode, *ToNode)));
    }
    if (Suggestions.Num() > 0) Out->SetArrayField(TEXT("suggestions"), Suggestions);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCreateInstance(const TSharedPtr<FJsonObject>& P)
{
    FString ParentPath, PkgPath, Name;
    if (!HaybaParams::GetString(P, TEXT("parent_material_path"), ParentPath)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing parent_material_path"));
    if (!HaybaParams::GetString(P, TEXT("package_path"), PkgPath)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing package_path"));
    if (!HaybaParams::GetString(P, TEXT("name"), Name)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing name"));

    UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr, *ParentPath);
    if (!Parent) return FHaybaHandlerResult::Err(TEXT("material_create_instance: parent material not found"));

    UMaterialInstanceConstantFactoryNew* Factory = NewObject<UMaterialInstanceConstantFactoryNew>();
    Factory->InitialParent = Parent;

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    // package_path may be the target directory OR the full asset path — see
    // material_function_create. Backward-compatible with the full-path convention.
    const FString Dir = (FPackageName::GetShortName(PkgPath) == Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_create_instance"), Dir, Name));
    }

    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterialInstanceConstant::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_create_instance: CreateAsset failed"));

    // Persist immediately (see material_create) so the instance survives a crash
    // before its first parameter is set.
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Created, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetParam(const TSharedPtr<FJsonObject>& P)
{
    FString InstPath, ParamName;
    if (!HaybaParams::GetString(P, TEXT("instance_path"), InstPath)) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing instance_path"));
    FHaybaParamReader ParamR(P, TEXT("material_set_param"));
    ParamName = ParamR.RequiredString(TEXT("param_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UMaterialInstanceConstant* MIC = LoadObject<UMaterialInstanceConstant>(nullptr, *InstPath);
    if (!MIC) return FHaybaHandlerResult::Err(TEXT("material_set_param: instance not found"));

    TSharedPtr<FJsonValue> Val = P->TryGetField(TEXT("value"));
    if (!Val.IsValid()) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing value"));

    FName PName(*ParamName);
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("param"), ParamName);

    // Honesty: the ...EditorOnly setters silently register an override for a
    // misspelled/nonexistent parameter and return void. Verify the parameter
    // actually exists in the material hierarchy first (bOverriddenOnly=false so
    // the default counts as "exists"), otherwise the caller would believe a real
    // parameter changed when nothing was affected.
    const FMaterialParameterInfo ParamInfo(PName);

    if (Val->Type == EJson::Number)
    {
        float ExistingScalar = 0.f;
        if (!MIC->GetScalarParameterValue(ParamInfo, ExistingScalar, /*bOveriddenOnly=*/false))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: scalar parameter '%s' does not exist on this material"), *ParamName));
        MIC->SetScalarParameterValueEditorOnly(PName, (float)Val->AsNumber());
        Out->SetNumberField(TEXT("value"), Val->AsNumber());
    }
    else if (Val->Type == EJson::Array)
    {
        FLinearColor ExistingVec;
        if (!MIC->GetVectorParameterValue(ParamInfo, ExistingVec, /*bOveriddenOnly=*/false))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: vector parameter '%s' does not exist on this material"), *ParamName));
        const TArray<TSharedPtr<FJsonValue>>& Arr = Val->AsArray();
        FLinearColor C(0,0,0,1);
        if (Arr.Num() > 0) C.R = Arr[0]->AsNumber();
        if (Arr.Num() > 1) C.G = Arr[1]->AsNumber();
        if (Arr.Num() > 2) C.B = Arr[2]->AsNumber();
        if (Arr.Num() > 3) C.A = Arr[3]->AsNumber();
        MIC->SetVectorParameterValueEditorOnly(PName, C);
        Out->SetStringField(TEXT("value"), C.ToString());
    }
    else if (Val->Type == EJson::String)
    {
        UTexture* ExistingTex = nullptr;
        if (!MIC->GetTextureParameterValue(ParamInfo, ExistingTex, /*bOveriddenOnly=*/false))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: texture parameter '%s' does not exist on this material"), *ParamName));
        FString TexPath = Val->AsString();
        UTexture* Tex = LoadObject<UTexture>(nullptr, *TexPath);
        if (!Tex) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_param: texture not found: %s"), *TexPath));
        MIC->SetTextureParameterValueEditorOnly(PName, Tex);
        Out->SetStringField(TEXT("value"), TexPath);
    }
    else if (Val->Type == EJson::Boolean)
    {
        // Task 5: static-switch parameter — uses StaticParameterSet + UpdateStaticPermutation.
        const bool bSwitch = Val->AsBool();
        FStaticParameterSet StaticParams;
        MIC->GetStaticParameterValues(StaticParams);
        bool bFound = false;
        for (FStaticSwitchParameter& SP : StaticParams.StaticSwitchParameters)
        {
            if (SP.ParameterInfo.Name == PName)
            {
                SP.Value = bSwitch;
                SP.bOverride = true;
                bFound = true;
                break;
            }
        }
        // Honesty: GetStaticParameterValues returns the full static-switch set
        // for the material hierarchy, so a name absent here does not exist on the
        // material. Previously we invented a new override, masking a bad name.
        if (!bFound)
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: static switch parameter '%s' does not exist on this material"), *ParamName));
        MIC->UpdateStaticPermutation(StaticParams);
        Out->SetBoolField(TEXT("value"), bSwitch);
    }
    else return FHaybaHandlerResult::Err(TEXT("material_set_param: unsupported value type"));

    // Instances carry no master graph, so PostEditChange here only updates the
    // instance permutation (no assert-prone translate); keep it, then persist
    // to disk so the param survives a later crash.
    MIC->PostEditChange();
    { FString SaveErr; HaybaPersistAsset(MIC, SaveErr); }
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatApply(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId, MatPath;
    int32 SlotIndex = 0;
    if (!HaybaParams::GetString(P, TEXT("actor_id"), ActorId)) return FHaybaHandlerResult::Err(TEXT("material_apply: missing actor_id"));
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_apply: missing material_path"));
    P->TryGetNumberField(TEXT("slot_index"), SlotIndex);

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorInWorld(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_apply: actor not found: %s"), *ActorId));

    UMaterialInterface* Mat = LoadObject<UMaterialInterface>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_apply: material not found"));

    UStaticMeshComponent* SMC = Actor->FindComponentByClass<UStaticMeshComponent>();
    if (!SMC) return FHaybaHandlerResult::Err(TEXT("material_apply: actor has no StaticMeshComponent"));
    SMC->SetMaterial(SlotIndex, Mat);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetNumberField(TEXT("slot_index"), SlotIndex);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatList(const TSharedPtr<FJsonObject>& P)
{
    FString Path = TEXT("/Game");
    P->TryGetStringField(TEXT("path"), Path);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByPath(FName(*Path), Assets, /*Recursive*/true);

    const int32 Cap = 200;
    TArray<TSharedPtr<FJsonValue>> Out;
    bool bCapped = false;
    for (const FAssetData& A : Assets)
    {
        UClass* Cls = A.GetClass();
        if (!Cls || !Cls->IsChildOf(UMaterialInterface::StaticClass())) continue;
        if (Out.Num() >= Cap) { bCapped = true; break; }

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  A.AssetName.ToString());
        Entry->SetStringField(TEXT("path"),  A.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), A.AssetClassPath.GetAssetName().ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("materials"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    Result->SetBoolField(TEXT("capped"), bCapped);
    return FHaybaHandlerResult::Ok(Result);
}

// Serialize a material/function expression list to JSON (id, class, inputs).
// Templated so it works for both UMaterial::GetExpressions() and
// UMaterialFunction::GetExpressions() regardless of their exact return type.
template <typename TExprRange>
static TArray<TSharedPtr<FJsonValue>> SerializeMaterialExpressions(
    const TExprRange& InExprs,
    const TSet<const UMaterialExpression*>* Consumed = nullptr,
    const TSet<const UMaterialExpression*>* Reachable = nullptr)
{
    TArray<TSharedPtr<FJsonValue>> Exprs;
    for (UMaterialExpression* Expr : InExprs)
    {
        if (!Expr) continue;
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("id"),    Expr->GetName());
        Entry->SetStringField(TEXT("class"), Expr->GetClass()->GetName());
        Entry->SetNumberField(TEXT("x"), Expr->MaterialExpressionEditorX);
        Entry->SetNumberField(TEXT("y"), Expr->MaterialExpressionEditorY);

        // Output wiring the C++ compiler sees but Python can't: is this node's
        // output consumed anywhere, and is it reachable from a material output
        // (i.e. live)? A node not reachable_from_output is provably dead — no
        // delete-recompile-compare dance needed.
        if (Consumed)  Entry->SetBoolField(TEXT("output_consumed"), Consumed->Contains(Expr));
        if (Reachable) Entry->SetBoolField(TEXT("reachable_from_output"), Reachable->Contains(Expr));

        // Named-reroute variable name — the single most-hand-rolled thing in
        // python_run (agents loop expressions reading variable_name to find a
        // declaration to bind a usage to). Surface it directly: declarations
        // report their own Name; usages report the name they resolve to.
        if (const UMaterialExpressionNamedRerouteDeclaration* Decl = Cast<UMaterialExpressionNamedRerouteDeclaration>(Expr))
        {
            Entry->SetStringField(TEXT("reroute_name"), Decl->Name.ToString());
            Entry->SetStringField(TEXT("reroute_kind"), TEXT("declaration"));
        }
        else if (const UMaterialExpressionNamedRerouteUsage* Usage = Cast<UMaterialExpressionNamedRerouteUsage>(Expr))
        {
            Entry->SetStringField(TEXT("reroute_name"), Usage->Declaration ? Usage->Declaration->Name.ToString() : FString());
            Entry->SetStringField(TEXT("reroute_kind"), TEXT("usage"));
        }

        TArray<TSharedPtr<FJsonValue>> Inputs;
        int32 InputIdx = 0;
        for (FExpressionInputIterator It{Expr}; It; ++It)
        {
            TSharedPtr<FJsonObject> InEntry = MakeShared<FJsonObject>();
            // Prefer the expression's display name (GetInputName) so Substrate
            // slab/operator pins report real names (Diffuse, Roughness, Normal,
            // ...) instead of falling back to the empty FExpressionInput name.
            const FName RealName = Expr->GetInputName(InputIdx);
            const FString InputName = !RealName.IsNone()
                ? RealName.ToString()
                : (It->InputName.IsNone() ? FString::Printf(TEXT("input_%d"), InputIdx) : It->InputName.ToString());
            InEntry->SetStringField(TEXT("name"), InputName);
            InEntry->SetNumberField(TEXT("index"), InputIdx);
            InEntry->SetBoolField(TEXT("connected"), It->Expression != nullptr);
            // The actual edge: which node/output feeds this input.
            if (It->Expression)
            {
                InEntry->SetStringField(TEXT("from_node"), It->Expression->GetName());
                InEntry->SetNumberField(TEXT("from_output"), It->OutputIndex);
            }
            ++InputIdx;
            Inputs.Add(MakeShared<FJsonValueObject>(InEntry.ToSharedRef()));
        }
        Entry->SetArrayField(TEXT("inputs"), Inputs);

        // OUTPUT pins (name + index). Critical for multi-output nodes — most
        // importantly MaterialFunctionCall, whose output order follows the
        // function's FunctionOutput SortPriority, NOT the visual top-to-bottom
        // order. Without this, a caller guesses the index and silently swaps
        // wires (e.g. Albedo->F0, F0->Diffuse). Connect with from_output set to
        // the NAME here (preferred) or from_output_index = this index.
        TArray<TSharedPtr<FJsonValue>> Outputs;
        {
            const TArray<FExpressionOutput>& Outs = Expr->GetOutputs();
            for (int32 OutIdx = 0; OutIdx < Outs.Num(); ++OutIdx)
            {
                TSharedPtr<FJsonObject> OutEntry = MakeShared<FJsonObject>();
                const FName OutName = Outs[OutIdx].OutputName;
                OutEntry->SetStringField(TEXT("name"),
                    OutName.IsNone() ? FString::Printf(TEXT("output_%d"), OutIdx) : OutName.ToString());
                OutEntry->SetNumberField(TEXT("index"), OutIdx);
                Outputs.Add(MakeShared<FJsonValueObject>(OutEntry.ToSharedRef()));
            }
        }
        Entry->SetArrayField(TEXT("outputs"), Outputs);

        Exprs.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }
    return Exprs;
}

// Forward decl — defined later (used by the validator path too).
static void GatherMaterialPropertyInputs(UMaterial* Mat, TArray<FExpressionInput*>& Out);

// Build the two graph sets the compiler implicitly knows:
//   Consumed  — every expression whose output feeds some node input or a root.
//   Reachable — every expression reachable (backward through inputs) from a
//               root input (material output pins, or function-output A pins).
// An expression NOT in Reachable is provably dead: deleting it cannot change
// the compiled result. RootInputs are the graph's terminal sinks.
template <typename TExprRange>
static void BuildMaterialGraphSets(
    const TExprRange& InExprs,
    const TArray<FExpressionInput*>& RootInputs,
    TSet<const UMaterialExpression*>& OutConsumed,
    TSet<const UMaterialExpression*>& OutReachable)
{
    for (UMaterialExpression* E : InExprs)
    {
        if (!E) continue;
        for (FExpressionInputIterator It{E}; It; ++It)
            if (It->Expression) OutConsumed.Add(It->Expression);
    }
    TArray<UMaterialExpression*> Stack;
    for (const FExpressionInput* In : RootInputs)
        if (In && In->Expression)
        {
            OutConsumed.Add(In->Expression);
            if (!OutReachable.Contains(In->Expression)) { OutReachable.Add(In->Expression); Stack.Add(In->Expression); }
        }
    while (Stack.Num() > 0)
    {
        UMaterialExpression* E = Stack.Pop();
        for (FExpressionInputIterator It{E}; It; ++It)
        {
            UMaterialExpression* S = It->Expression;
            if (S && !OutReachable.Contains(S)) { OutReachable.Add(S); Stack.Add(S); }
        }
    }
}

// Collect the ids of expressions not reachable from any output (dead nodes).
template <typename TExprRange>
static TArray<TSharedPtr<FJsonValue>> CollectDeadNodeIds(
    const TExprRange& InExprs, const TSet<const UMaterialExpression*>& Reachable)
{
    TArray<TSharedPtr<FJsonValue>> Dead;
    for (UMaterialExpression* E : InExprs)
    {
        if (!E) continue;
        if (E->IsA<UMaterialExpressionComment>()) continue; // comments aren't graph nodes
        if (!Reachable.Contains(E))
        {
            TSharedPtr<FJsonObject> D = MakeShared<FJsonObject>();
            D->SetStringField(TEXT("id"), E->GetName());
            D->SetStringField(TEXT("class"), E->GetClass()->GetName());
            Dead.Add(MakeShared<FJsonValueObject>(D.ToSharedRef()));
        }
    }
    return Dead;
}

// Serialize the comment boxes (id/text/pos/size) so callers can discover
// comment ids to pass to material_delete_comment.
static TArray<TSharedPtr<FJsonValue>> SerializeComments(TConstArrayView<TObjectPtr<UMaterialExpressionComment>> InComments)
{
    TArray<TSharedPtr<FJsonValue>> Out;
    for (const TObjectPtr<UMaterialExpressionComment>& C : InComments)
    {
        if (!C) continue;
        TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
        E->SetStringField(TEXT("id"), C->GetName());
        E->SetStringField(TEXT("text"), C->Text);
        E->SetNumberField(TEXT("x"), C->MaterialExpressionEditorX);
        E->SetNumberField(TEXT("y"), C->MaterialExpressionEditorY);
        E->SetNumberField(TEXT("size_x"), C->SizeX);
        E->SetNumberField(TEXT("size_y"), C->SizeY);
        Out.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
    }
    return Out;
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!HaybaParams::GetString(P, TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("material_get_info: missing path"));

    // UMaterial first, then fall back to UMaterialFunction (same GetExpressions()
    // graph API). Material instances are not handled here (they have no graph).
    if (UMaterial* Mat = LoadObject<UMaterial>(nullptr, *Path))
    {
        // Edge graph + reachability: roots are the material's output property pins.
        TArray<FExpressionInput*> Roots;
        GatherMaterialPropertyInputs(Mat, Roots);
        TSet<const UMaterialExpression*> Consumed, Reachable;
        BuildMaterialGraphSets(Mat->GetExpressions(), Roots, Consumed, Reachable);

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("kind"), TEXT("material"));
        Out->SetStringField(TEXT("name"), Mat->GetName());
        Out->SetArrayField(TEXT("expressions"), SerializeMaterialExpressions(Mat->GetExpressions(), &Consumed, &Reachable));
        Out->SetArrayField(TEXT("dead_nodes"), CollectDeadNodeIds(Mat->GetExpressions(), Reachable));
        Out->SetArrayField(TEXT("comments"), SerializeComments(Mat->GetEditorComments()));
        Out->SetNumberField(TEXT("shading_model"), (int32)Mat->GetShadingModels().GetFirstShadingModel());
        return FHaybaHandlerResult::Ok(Out);
    }

    if (UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *Path))
    {
        // Roots are the A input of every FunctionOutput node.
        TArray<FExpressionInput*> Roots;
        for (UMaterialExpression* E : Fn->GetExpressions())
            if (UMaterialExpressionFunctionOutput* FO = Cast<UMaterialExpressionFunctionOutput>(E))
                Roots.Add(&FO->A);
        TSet<const UMaterialExpression*> Consumed, Reachable;
        BuildMaterialGraphSets(Fn->GetExpressions(), Roots, Consumed, Reachable);

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("kind"), TEXT("function"));
        Out->SetStringField(TEXT("name"), Fn->GetName());
        Out->SetStringField(TEXT("description"), Fn->Description);
        Out->SetArrayField(TEXT("expressions"), SerializeMaterialExpressions(Fn->GetExpressions(), &Consumed, &Reachable));
        Out->SetArrayField(TEXT("dead_nodes"), CollectDeadNodeIds(Fn->GetExpressions(), Reachable));
        Out->SetArrayField(TEXT("comments"), SerializeComments(Fn->GetEditorComments()));
        return FHaybaHandlerResult::Ok(Out);
    }

    // Task 5: UMaterialInstanceConstant — return kind, name, parent, and all parameters.
    if (UMaterialInstanceConstant* MIC = LoadObject<UMaterialInstanceConstant>(nullptr, *Path))
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("kind"), TEXT("instance"));
        Out->SetStringField(TEXT("name"), MIC->GetName());
        Out->SetStringField(TEXT("parent"), MIC->Parent ? MIC->Parent->GetPathName() : TEXT(""));

        TArray<TSharedPtr<FJsonValue>> Params;

        // Scalar parameters
        TArray<FMaterialParameterInfo> ScalarInfos;
        TArray<FGuid> ScalarGuids;
        MIC->GetAllScalarParameterInfo(ScalarInfos, ScalarGuids);
        for (const FMaterialParameterInfo& Info : ScalarInfos)
        {
            float Val = 0.f;
            MIC->GetScalarParameterValue(Info, Val);
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("name"), Info.Name.ToString());
            E->SetStringField(TEXT("type"), TEXT("scalar"));
            E->SetNumberField(TEXT("value"), Val);
            Params.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        }

        // Vector parameters
        TArray<FMaterialParameterInfo> VecInfos;
        TArray<FGuid> VecGuids;
        MIC->GetAllVectorParameterInfo(VecInfos, VecGuids);
        for (const FMaterialParameterInfo& Info : VecInfos)
        {
            FLinearColor Val;
            MIC->GetVectorParameterValue(Info, Val);
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("name"), Info.Name.ToString());
            E->SetStringField(TEXT("type"), TEXT("vector"));
            TArray<TSharedPtr<FJsonValue>> RGBA = {
                MakeShared<FJsonValueNumber>(Val.R), MakeShared<FJsonValueNumber>(Val.G),
                MakeShared<FJsonValueNumber>(Val.B), MakeShared<FJsonValueNumber>(Val.A),
            };
            E->SetArrayField(TEXT("value"), RGBA);
            Params.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        }

        // Texture parameters
        TArray<FMaterialParameterInfo> TexInfos;
        TArray<FGuid> TexGuids;
        MIC->GetAllTextureParameterInfo(TexInfos, TexGuids);
        for (const FMaterialParameterInfo& Info : TexInfos)
        {
            UTexture* Tex = nullptr;
            MIC->GetTextureParameterValue(Info, Tex);
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("name"), Info.Name.ToString());
            E->SetStringField(TEXT("type"), TEXT("texture"));
            E->SetStringField(TEXT("value"), Tex ? Tex->GetPathName() : TEXT(""));
            Params.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        }

        // Static switch parameters
        TArray<FMaterialParameterInfo> SwitchInfos;
        TArray<FGuid> SwitchGuids;
        MIC->GetAllStaticSwitchParameterInfo(SwitchInfos, SwitchGuids);
        for (int32 i = 0; i < SwitchInfos.Num(); ++i)
        {
            bool bVal = false; FGuid SwitchGuid;
            MIC->GetStaticSwitchParameterValue(SwitchInfos[i], bVal, SwitchGuid);
            TSharedPtr<FJsonObject> E = MakeShared<FJsonObject>();
            E->SetStringField(TEXT("name"), SwitchInfos[i].Name.ToString());
            E->SetStringField(TEXT("type"), TEXT("static_switch"));
            E->SetBoolField(TEXT("value"), bVal);
            Params.Add(MakeShared<FJsonValueObject>(E.ToSharedRef()));
        }

        Out->SetArrayField(TEXT("parameters"), Params);
        return FHaybaHandlerResult::Ok(Out);
    }

    return FHaybaHandlerResult::Err(TEXT("material_get_info: no UMaterial or UMaterialFunction at path"));
}

// Move and/or re-property an existing node by id, in a material or function.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetNode(const TSharedPtr<FJsonObject>& P)
{
    FString NodeId;
    FHaybaParamReader ParamR(P, TEXT("material_set_node"));
    NodeId = ParamR.RequiredString(TEXT("node_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    int32 X = 0, Y = 0; bool bHasPos = false;
    const TArray<TSharedPtr<FJsonValue>>* Pos;
    if (P->TryGetArrayField(TEXT("node_pos"), Pos) && Pos->Num() >= 2)
    {
        X = (int32)(*Pos)[0]->AsNumber();
        Y = (int32)(*Pos)[1]->AsNumber();
        bHasPos = true;
    }
    const TSharedPtr<FJsonObject>* PropsObj = nullptr;
    P->TryGetObjectField(TEXT("properties"), PropsObj);

    FApplyNodePropsResult PR;
    auto ApplyTo = [&](UMaterialExpression* Expr) {
        if (bHasPos) { Expr->MaterialExpressionEditorX = X; Expr->MaterialExpressionEditorY = Y; }
        if (PropsObj) PR = ApplyNodeProps(Expr, *PropsObj);
    };

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_set_node: function not found"));
        UMaterialExpression* Expr = FindExprByNameInFunction(Fn, NodeId);
        if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_node: node not found: %s"), *NodeId));
        ApplyTo(Expr);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), NodeId);
        AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_set_node"));
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_set_node: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_node: node not found: %s"), *NodeId));
    ApplyTo(Expr);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), NodeId);
    AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_set_node"));
    return FHaybaHandlerResult::Ok(Out);
}

// Delete an existing node by id, in a material or function.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDeleteNode(const TSharedPtr<FJsonObject>& P)
{
    FString NodeId;
    FHaybaParamReader ParamR(P, TEXT("material_delete_node"));
    NodeId = ParamR.RequiredString(TEXT("node_id"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_delete_node: function not found"));
        UMaterialExpression* Expr = FindExprByNameInFunction(Fn, NodeId);
        if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
        UMaterialEditingLibrary::DeleteMaterialExpressionInFunction(Fn, Expr);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("deleted"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_delete_node: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_delete_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
    UMaterialEditingLibrary::DeleteMaterialExpression(Mat, Expr);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("deleted"), true);
    return FHaybaHandlerResult::Ok(Out);
}

// Add a titled comment BOX (not a graph node). Comment boxes live in the
// expression collection's EditorComments array, separate from Expressions —
// CreateMaterialExpression would otherwise drop a stray empty node.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddComment(const TSharedPtr<FJsonObject>& P)
{
    FString Text;
    P->TryGetStringField(TEXT("text"), Text);

    int32 X = 0, Y = 0, W = 400, H = 200, Font = 18;
    const TArray<TSharedPtr<FJsonValue>>* Arr;
    if (P->TryGetArrayField(TEXT("node_pos"), Arr) && Arr->Num() >= 2) { X = (int32)(*Arr)[0]->AsNumber(); Y = (int32)(*Arr)[1]->AsNumber(); }
    if (P->TryGetArrayField(TEXT("size"), Arr) && Arr->Num() >= 2)     { W = (int32)(*Arr)[0]->AsNumber(); H = (int32)(*Arr)[1]->AsNumber(); }
    FLinearColor Color = FLinearColor::White;
    if (P->TryGetArrayField(TEXT("color"), Arr) && Arr->Num() >= 3)
        Color = FLinearColor((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber(), Arr->Num() >= 4 ? (*Arr)[3]->AsNumber() : 1.0);
    { int32 F; if (P->TryGetNumberField(TEXT("font_size"), F)) Font = F; }

    auto Setup = [&](UMaterialExpressionComment* C) {
        C->Text = Text; C->SizeX = W; C->SizeY = H; C->CommentColor = Color; C->FontSize = Font;
        C->MaterialExpressionEditorX = X; C->MaterialExpressionEditorY = Y;
    };

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_comment: function not found"));
        UMaterialExpressionComment* C = NewObject<UMaterialExpressionComment>(Fn);
        Setup(C);
        Fn->GetExpressionCollection().AddComment(C);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("comment_id"), C->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_comment: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_comment: material not found"));
    UMaterialExpressionComment* C = NewObject<UMaterialExpressionComment>(Mat);
    Setup(C);
    Mat->GetExpressionCollection().AddComment(C);
    // Comments don't affect compilation; persist to disk (no PostEditChange,
    // which would needlessly translate the material).
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("comment_id"), C->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

// Delete a comment BOX by id. Comments live in the expression collection's
// EditorComments array (not Expressions), so material_delete_node can't reach
// them — this is the dedicated remover. (Named-reroute declaration/usage nodes
// ARE expressions, so material_delete_node already deletes those.)
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDeleteComment(const TSharedPtr<FJsonObject>& P)
{
    FString CommentId;
    if (!P->TryGetStringField(TEXT("comment_id"), CommentId) || CommentId.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_delete_comment: missing comment_id"));

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_delete_comment: function not found"));
        for (const TObjectPtr<UMaterialExpressionComment>& C : Fn->GetEditorComments())
        {
            if (C && C->GetName() == CommentId)
            {
                Fn->GetExpressionCollection().RemoveComment(C);
                UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
                { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }
                TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
                Out->SetBoolField(TEXT("deleted"), true);
                return FHaybaHandlerResult::Ok(Out);
            }
        }
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_comment: comment not found: %s"), *CommentId));
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_delete_comment: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_delete_comment: material not found"));
    for (const TObjectPtr<UMaterialExpressionComment>& C : Mat->GetEditorComments())
    {
        if (C && C->GetName() == CommentId)
        {
            Mat->GetExpressionCollection().RemoveComment(C);
            Mat->MarkPackageDirty();  // comments don't affect compilation; in-memory per the deferred-compile model
            TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
            Out->SetBoolField(TEXT("deleted"), true);
            return FHaybaHandlerResult::Ok(Out);
        }
    }
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_comment: comment not found: %s"), *CommentId));
}

// Edit an existing comment BOX by id — move / resize / retitle / recolor. Only
// the fields supplied are changed, so callers can e.g. just reposition a box
// after relocating the nodes it wraps. Completes comment CRUD so comments never
// need a Python fallback.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetComment(const TSharedPtr<FJsonObject>& P)
{
    FString CommentId;
    if (!P->TryGetStringField(TEXT("comment_id"), CommentId) || CommentId.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_set_comment: missing comment_id"));

    // Apply only the provided fields to a found comment.
    const TArray<TSharedPtr<FJsonValue>>* Arr;
    auto Apply = [&](UMaterialExpressionComment* C)
    {
        FString Text;
        if (P->TryGetStringField(TEXT("text"), Text)) C->Text = Text;
        if (P->TryGetArrayField(TEXT("node_pos"), Arr) && Arr->Num() >= 2)
        { C->MaterialExpressionEditorX = (int32)(*Arr)[0]->AsNumber(); C->MaterialExpressionEditorY = (int32)(*Arr)[1]->AsNumber(); }
        if (P->TryGetArrayField(TEXT("size"), Arr) && Arr->Num() >= 2)
        { C->SizeX = (int32)(*Arr)[0]->AsNumber(); C->SizeY = (int32)(*Arr)[1]->AsNumber(); }
        if (P->TryGetArrayField(TEXT("color"), Arr) && Arr->Num() >= 3)
            C->CommentColor = FLinearColor((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber(), Arr->Num() >= 4 ? (*Arr)[3]->AsNumber() : 1.0);
        { int32 F; if (P->TryGetNumberField(TEXT("font_size"), F)) C->FontSize = F; }
    };

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_set_comment: function not found"));
        for (const TObjectPtr<UMaterialExpressionComment>& C : Fn->GetEditorComments())
        {
            if (C && C->GetName() == CommentId)
            {
                Apply(C);
                UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
                { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }
                TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
                Out->SetStringField(TEXT("comment_id"), CommentId);
                return FHaybaHandlerResult::Ok(Out);
            }
        }
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_comment: comment not found: %s"), *CommentId));
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_set_comment: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_comment: material not found"));
    for (const TObjectPtr<UMaterialExpressionComment>& C : Mat->GetEditorComments())
    {
        if (C && C->GetName() == CommentId)
        {
            Apply(C);
            Mat->MarkPackageDirty();  // comments don't affect compilation; in-memory per the deferred-compile model
            TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
            Out->SetStringField(TEXT("comment_id"), CommentId);
            return FHaybaHandlerResult::Ok(Out);
        }
    }
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_comment: comment not found: %s"), *CommentId));
}

// Create a Named-Reroute DECLARATION node (the source anchor). Lands in the
// graph like a normal node, then gets its Name + a stable VariableGuid so
// usages can bind to it. The caller wires the source into its Input pin with
// material_connect_nodes (to_node = <this id>).
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddRerouteDeclaration(const TSharedPtr<FJsonObject>& P)
{
    FString Name;
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: missing name"));

    int32 X = 0, Y = 0; bool bHasPos = false;
    const TArray<TSharedPtr<FJsonValue>>* Arr;
    if (P->TryGetArrayField(TEXT("node_pos"), Arr) && Arr->Num() >= 2) { X = (int32)(*Arr)[0]->AsNumber(); Y = (int32)(*Arr)[1]->AsNumber(); bHasPos = true; }
    FLinearColor Color; bool bHasColor = false;
    if (P->TryGetArrayField(TEXT("color"), Arr) && Arr->Num() >= 3)
    { Color = FLinearColor((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber(), Arr->Num() >= 4 ? (*Arr)[3]->AsNumber() : 1.0); bHasColor = true; }

    UClass* Cls = UMaterialExpressionNamedRerouteDeclaration::StaticClass();
    auto Setup = [&](UMaterialExpressionNamedRerouteDeclaration* D) {
        D->Name = FName(*Name);
        if (bHasColor) D->NodeColor = Color;
        // VariableGuid is auto-generated in PostInitProperties (private
        // UpdateVariableGuid); guard in case it's empty so usages can bind.
        if (!D->VariableGuid.IsValid()) D->VariableGuid = FGuid::NewGuid();
    };

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: function not found"));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, Cls, X, Y));
        if (!D) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: create failed"));
        Setup(D);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), D->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: material not found"));
    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(UMaterialEditingLibrary::CreateMaterialExpression(Mat, Cls, X, Y));
    if (!D) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: create failed"));
    Setup(D);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), D->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

// Create a Named-Reroute USAGE node bound to an existing declaration by object
// pointer + GUID (not a wire — material_connect_nodes can't express this). Its
// output is wired to targets with material_connect_nodes (from_node = <this id>).
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddRerouteUsage(const TSharedPtr<FJsonObject>& P)
{
    FString DeclId;
    if (!P->TryGetStringField(TEXT("declaration_id"), DeclId) || DeclId.IsEmpty()) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: missing declaration_id"));

    int32 X = 0, Y = 0; bool bHasPos = false;
    const TArray<TSharedPtr<FJsonValue>>* Arr;
    if (P->TryGetArrayField(TEXT("node_pos"), Arr) && Arr->Num() >= 2) { X = (int32)(*Arr)[0]->AsNumber(); Y = (int32)(*Arr)[1]->AsNumber(); bHasPos = true; }

    UClass* Cls = UMaterialExpressionNamedRerouteUsage::StaticClass();

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: function not found"));
        UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(FindExprByNameInFunction(Fn, DeclId));
        if (!D) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_usage: declaration not found: %s"), *DeclId));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        UMaterialExpressionNamedRerouteUsage* U = Cast<UMaterialExpressionNamedRerouteUsage>(UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, Cls, X, Y));
        if (!U) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: create failed"));
        U->Declaration = D;
        U->DeclarationGuid = D->VariableGuid;
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), U->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: material not found"));
    UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(FindExprByName(Mat, DeclId));
    if (!D) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_usage: declaration not found: %s"), *DeclId));
    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    UMaterialExpressionNamedRerouteUsage* U = Cast<UMaterialExpressionNamedRerouteUsage>(UMaterialEditingLibrary::CreateMaterialExpression(Mat, Cls, X, Y));
    if (!U) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: create failed"));
    U->Declaration = D;
    U->DeclarationGuid = D->VariableGuid;
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), U->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetProperty(const TSharedPtr<FJsonObject>& P)
{
    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_set_property: missing material_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_property: material not found"));

    const TSharedPtr<FJsonObject>* PropsObj = nullptr;
    if (!P->TryGetObjectField(TEXT("properties"), PropsObj) || !PropsObj)
        return FHaybaHandlerResult::Err(TEXT("material_set_property: missing properties"));

    // Friendly alias -> real UMaterial UPROPERTY name.
    static const TMap<FString, FString> Aliases = {
        { TEXT("domain"),                  TEXT("MaterialDomain") },
        { TEXT("blend_mode"),              TEXT("BlendMode") },
        { TEXT("shading_model"),           TEXT("ShadingModel") },
        { TEXT("two_sided"),               TEXT("TwoSided") },
        { TEXT("opacity_mask_clip_value"), TEXT("OpacityMaskClipValue") },
        { TEXT("enable_tessellation"),     TEXT("bEnableTessellation") },  // required for the displacement output to tessellate (Nanite)
    };

    TArray<TSharedPtr<FJsonValue>> Applied;
    for (const auto& Pair : (*PropsObj)->Values)
    {
        const FString Key = FString(*Pair.Key);
        const FString* Real = Aliases.Find(Key);
        const FString RealName = Real ? *Real : Key;
        if (HaybaReflection::SetProp(Mat, RealName, Pair.Value))
            Applied.Add(MakeShared<FJsonValueString>(Key));
    }

    // In-memory only: master materials are written to disk solely by
    // material_compile, so settings changes never leave a half-built material on
    // disk for the editor to compile-on-open (Substrate Normal-chunk assert).
    Mat->MarkPackageDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("applied"), Applied);
    Out->SetBoolField(TEXT("saved"), false);
    Out->SetStringField(TEXT("note"), TEXT("call material_compile to apply settings and write the material to disk"));
    return FHaybaHandlerResult::Ok(Out);
}

// Explicit, deferred compile. This is the ONE place the master-material graph
// is translated (the per-edit handlers only save). PostEditChange applies any
// settings staged by material_set_property; RecompileMaterial forces the shader
// translate so compile errors surface. A truly pathological graph can still hit
// an engine check() here and crash — but every prior edit was already saved to
// disk, so the AI's progress is recoverable on restart. Returns the translator
// errors so the agent gets feedback instead of guessing.
// ── Graph validation ─────────────────────────────────────────────────────────
// The HLSL translator asserts (uncatchable check 'Default != nullptr' in
// FHLSLMaterialTranslator::GetParameterCodeRaw) when a CONSUMED expression
// compiles to INDEX_NONE and the consumer reads it without a default. The
// dominant authoring cause is a reroute / named-reroute that is wired downstream
// but resolves to no real input (e.g. a named-reroute usage whose declaration's
// input was never connected). A connection to a non-existent output index is the
// other. Both are statically detectable BEFORE we ask the engine to translate,
// so we can refuse instead of letting the editor crash.
static void CollectMaterialGraphProblems(
    const TConstArrayView<TObjectPtr<UMaterialExpression>>& Exprs,
    const TArray<FExpressionInput*>& PropertyInputs,
    TArray<FString>& Out)
{
    // 1. Consumed set: every expression referenced by some input (node or property).
    TSet<const UMaterialExpression*> Consumed;
    auto Note = [&Consumed](const FExpressionInput* In)
    {
        if (In && In->Expression) Consumed.Add(In->Expression);
    };
    for (const TObjectPtr<UMaterialExpression>& EP : Exprs)
    {
        UMaterialExpression* E = EP.Get();
        if (!E) continue;
        const int32 N = E->CountInputs();
        for (int32 i = 0; i < N; ++i) Note(E->GetInput(i));
    }
    for (const FExpressionInput* In : PropertyInputs) Note(In);

    // 2. Flag the crash-prone shapes.
    for (const TObjectPtr<UMaterialExpression>& EP : Exprs)
    {
        UMaterialExpression* E = EP.Get();
        if (!E) continue;

        if (UMaterialExpressionRerouteBase* RR = Cast<UMaterialExpressionRerouteBase>(E))
        {
            if (Consumed.Contains(E))
            {
                int32 OutIdx = 0;
                if (RR->TraceInputsToRealExpression(OutIdx) == nullptr)
                {
                    Out.Add(FString::Printf(TEXT("reroute '%s' is used downstream but resolves to no input — it compiles to an invalid (null) value and crashes the HLSL translator (check 'Default != nullptr'). Connect its input (for a NAMED reroute, connect the matching DECLARATION's input), or delete the reroute and its usages."), *E->GetName()));
                }
            }
        }

        const int32 N = E->CountInputs();
        for (int32 i = 0; i < N; ++i)
        {
            const FExpressionInput* In = E->GetInput(i);
            if (!In || !In->Expression) continue;
            const int32 OutCount = In->Expression->GetOutputs().Num();
            if (OutCount > 0 && (In->OutputIndex < 0 || In->OutputIndex >= OutCount))
            {
                Out.Add(FString::Printf(TEXT("'%s' input %d connects to output #%d of '%s', which has only %d output(s) — an out-of-range output index compiles to null and crashes the translator. Reconnect to a valid output (0..%d)."), *E->GetName(), i, In->OutputIndex, *In->Expression->GetName(), OutCount, OutCount - 1));
            }
        }
    }
}

// Gather the master material's per-property root inputs so reroutes feeding a
// material property directly (not via another node) still count as consumed.
static void GatherMaterialPropertyInputs(UMaterial* Mat, TArray<FExpressionInput*>& Out)
{
    if (!Mat) return;
    for (int32 Prop = 0; Prop < MP_MAX; ++Prop)
        if (FExpressionInput* In = Mat->GetExpressionInputForProperty((EMaterialProperty)Prop))
            Out.Add(In);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatValidate(const TSharedPtr<FJsonObject>& P)
{
    TArray<FString> Problems;

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_validate: function not found"));
        CollectMaterialGraphProblems(Fn->GetExpressions(), {}, Problems);
    }
    else
    {
        FString MatPath;
        if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
            return FHaybaHandlerResult::Err(TEXT("material_validate: missing material_path or function_path"));
        UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
        if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_validate: material not found"));
        TArray<FExpressionInput*> PropInputs;
        GatherMaterialPropertyInputs(Mat, PropInputs);
        CollectMaterialGraphProblems(Mat->GetExpressions(), PropInputs, Problems);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("ok"), Problems.Num() == 0);
    TArray<TSharedPtr<FJsonValue>> Arr;
    for (const FString& Pr : Problems) Arr.Add(MakeShared<FJsonValueString>(Pr));
    Out->SetArrayField(TEXT("problems"), Arr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCompile(const TSharedPtr<FJsonObject>& P)
{
    // Material FUNCTIONS are no longer auto-saved per edit (a half-built function
    // on disk asserts when the editor opens/compiles it). This is their explicit
    // save point: refresh + write to disk.
    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_compile: function not found"));

        // Refuse to translate a crash-prone graph (uncatchable translator assert).
        TArray<FString> Problems;
        CollectMaterialGraphProblems(Fn->GetExpressions(), {}, Problems);
        if (Problems.Num() > 0)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& Pr : Problems) Arr.Add(MakeShared<FJsonValueString>(Pr));
            Bad->SetArrayField(TEXT("errors"), Arr);
            Bad->SetStringField(TEXT("blocked"), TEXT("graph would crash the HLSL translator; not compiled. Fix the listed problems (or run material_validate) then retry."));
            return FHaybaHandlerResult::Ok(Bad);
        }

        // UpdateMaterialFunction recompiles the function + broadcasts editor
        // notifications — same dead-Python-delegate AV risk as material recompile.
        bool bFnCrashed = false;
        HaybaSeh::RunGuarded(+[](void* P)
        {
            UMaterialEditingLibrary::UpdateMaterialFunction(static_cast<UMaterialFunction*>(P), nullptr);
        }, Fn, bFnCrashed);
        if (bFnCrashed)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetStringField(TEXT("crash_guarded"), TEXT("material_compile(function): native access violation during UpdateMaterialFunction — commonly a stale Python-registered editor delegate firing on a GC'd target. Editor kept alive by the SEH guard; function NOT saved."));
            return FHaybaHandlerResult::Ok(Bad);
        }
        FString FnSaveErr;
        const bool bFnSaved = HaybaPersistAsset(Fn, FnSaveErr);
        TSharedPtr<FJsonObject> FnOut = MakeShared<FJsonObject>();
        FnOut->SetBoolField(TEXT("saved"), bFnSaved);
        if (!bFnSaved) FnOut->SetStringField(TEXT("save_error"), FnSaveErr);
        return FHaybaHandlerResult::Ok(FnOut);
    }

    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_compile: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_compile: material not found"));

    // Refuse to translate a crash-prone graph: RecompileMaterial below runs the
    // HLSL translator, whose 'Default != nullptr' assert is uncatchable and kills
    // the editor. Catch the statically-detectable causes first and report them.
    {
        TArray<FExpressionInput*> PropInputs;
        GatherMaterialPropertyInputs(Mat, PropInputs);
        TArray<FString> Problems;
        CollectMaterialGraphProblems(Mat->GetExpressions(), PropInputs, Problems);
        if (Problems.Num() > 0)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& Pr : Problems) Arr.Add(MakeShared<FJsonValueString>(Pr));
            Bad->SetArrayField(TEXT("errors"), Arr);
            Bad->SetStringField(TEXT("blocked"), TEXT("graph would crash the HLSL translator; not compiled. Fix the listed problems (or run material_validate) then retry."));
            return FHaybaHandlerResult::Ok(Bad);
        }
    }

    // PostEditChange + RecompileMaterial broadcast editor change notifications
    // (FCoreUObjectDelegates, MaterialEditor). If a Python script registered a
    // delegate whose target was since garbage-collected/destroyed, that broadcast
    // dereferences freed memory — a native access violation that would kill the
    // editor (not a catchable C++/Python exception). Guard it.
    {
        bool bCompileCrashed = false;
        HaybaSeh::RunGuarded(+[](void* P)
        {
            UMaterial* M = static_cast<UMaterial*>(P);
            M->PostEditChange();
            UMaterialEditingLibrary::RecompileMaterial(M);
        }, Mat, bCompileCrashed);
        if (bCompileCrashed)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            Bad->SetStringField(TEXT("crash_guarded"), TEXT("material_compile: native access violation during recompile/PostEditChange — commonly a stale Python-registered editor delegate firing on a garbage-collected target, or a re-entrant property broadcast. The editor was kept alive by the SEH guard and the material was NOT saved. Do not register UE editor delegates from python_run whose targets can be GC'd."));
            return FHaybaHandlerResult::Ok(Bad);
        }
    }

    TArray<TSharedPtr<FJsonValue>> Errs;
    FMaterialResource* Res = Mat->GetMaterialResource(GMaxRHIShaderPlatform);
    if (Res)
        for (const FString& E : Res->GetCompileErrors())
            Errs.Add(MakeShared<FJsonValueString>(E));

    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Mat, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("errors"), Errs);
    Out->SetBoolField(TEXT("has_errors"), Errs.Num() > 0);
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);

    // ── Optimization feedback ────────────────────────────────────────────────
    // After a clean recompile, read shader cost off the recompiled
    // FMaterialResource — the same numbers the Material Editor Stats panel shows
    // — so the AI building this material via MCP gets instruction counts,
    // texture samples, samplers, and interpolator usage as actionable feedback.
    if (Res && Errs.Num() == 0)
    {
        TSharedPtr<FJsonObject> Stats = MakeShared<FJsonObject>();

        // Instruction counts per representative shader permutation.
        // ExtractMatertialStatsInfo is MATERIALEDITOR_API-exported; it internally
        // calls GetRepresentativeInstructionCounts (which is not exported).
        FShaderStatsInfo Info;
        // Also MaterialEditor — guard it; on a fault Info stays empty and the
        // loops below just emit empty stats (never crashes the editor).
        {
            struct FStatsCtx { FShaderStatsInfo* I; FMaterialResource* R; } Ctx{ &Info, Res };
            bool bStatsCrashed = false;
            HaybaSeh::RunGuarded(+[](void* P)
            {
                FStatsCtx* C = static_cast<FStatsCtx*>(P);
                FMaterialStatsUtils::ExtractMatertialStatsInfo(GMaxRHIShaderPlatform, *C->I, C->R);
            }, &Ctx, bStatsCrashed);
        }

        // Local name map — FMaterialStatsUtils::RepresentativeShaderTypeToString is
        // not exported to plugins (link error), so map the (small, stable) enum here.
        auto RepShaderName = [](ERepresentativeShader S) -> FString
        {
            switch (S)
            {
                case ERepresentativeShader::StationarySurface:            return TEXT("Stationary surface");
                case ERepresentativeShader::StationarySurfaceCSM:         return TEXT("Stationary surface + CSM");
                case ERepresentativeShader::StationarySurfaceNPointLights:return TEXT("Stationary surface + N point lights");
                case ERepresentativeShader::DynamicallyLitObject:         return TEXT("Dynamically lit object");
                case ERepresentativeShader::RuntimeVirtualTextureOutput:  return TEXT("Runtime virtual texture output");
                case ERepresentativeShader::UIDefaultFragmentShader:      return TEXT("UI pixel shader");
                case ERepresentativeShader::StaticMesh:                   return TEXT("Static mesh vertex shader");
                case ERepresentativeShader::SkeletalMesh:                 return TEXT("Skeletal mesh vertex shader");
                case ERepresentativeShader::SkinnedCloth:                 return TEXT("Skinned cloth vertex shader");
                case ERepresentativeShader::UIDefaultVertexShader:        return TEXT("UI vertex shader");
                case ERepresentativeShader::UIInstancedVertexShader:      return TEXT("UI instanced vertex shader");
                case ERepresentativeShader::NaniteMesh:                   return TEXT("Nanite mesh shader");
                default:                                                  return FString::Printf(TEXT("shader_%d"), (int32)S);
            }
        };

        TArray<TSharedPtr<FJsonValue>> Shaders;
        int32 PeakInstructions = 0;
        for (const TPair<ERepresentativeShader, FShaderStatsInfo::FContent>& Pair : Info.ShaderInstructionCount)
        {
            // StrDescription is the bare instruction count (e.g. "142") or "n/a".
            const FString& Desc = Pair.Value.StrDescription;
            int32 Count = 0;
            const bool bNumeric = Desc.IsNumeric() && (Count = FCString::Atoi(*Desc)) >= 0;
            if (!bNumeric) continue;
            PeakInstructions = FMath::Max(PeakInstructions, Count);

            TSharedPtr<FJsonObject> ShaderObj = MakeShared<FJsonObject>();
            ShaderObj->SetStringField(TEXT("name"), RepShaderName(Pair.Key));
            ShaderObj->SetNumberField(TEXT("instructions"), Count);
            Shaders.Add(MakeShared<FJsonValueObject>(ShaderObj));
        }
        Stats->SetArrayField(TEXT("shaders"), Shaders);
        Stats->SetNumberField(TEXT("peak_instructions"), PeakInstructions);

        // Numeric stats straight off the exported FMaterialResource getters.
        uint32 NumVSTextureSamples = 0, NumPSTextureSamples = 0;
        Res->GetEstimatedNumTextureSamples(NumVSTextureSamples, NumPSTextureSamples);
        Stats->SetNumberField(TEXT("texture_samples"), (double)(NumVSTextureSamples + NumPSTextureSamples));
        Stats->SetNumberField(TEXT("texture_samples_vs"), (double)NumVSTextureSamples);
        Stats->SetNumberField(TEXT("texture_samples_ps"), (double)NumPSTextureSamples);
        // Lookups: estimated samples + virtual-texture lookups.
        const uint32 NumVTLookups = Res->GetEstimatedNumVirtualTextureLookups();
        Stats->SetNumberField(TEXT("virtual_texture_lookups"), (double)NumVTLookups);
        Stats->SetNumberField(TEXT("texture_lookups"), (double)(NumVSTextureSamples + NumPSTextureSamples + NumVTLookups));

        const int32 SamplersUsed = FMath::Max(Res->GetSamplerUsage(), 0);
        const int32 MaxSamplers = GetExpectedFeatureLevelMaxTextureSamplers(Res->GetFeatureLevel());
        Stats->SetNumberField(TEXT("samplers"), SamplersUsed);
        Stats->SetNumberField(TEXT("max_samplers"), MaxSamplers);

        uint32 UVScalars = 0, CustomScalars = 0;
        Res->GetUserInterpolatorUsage(UVScalars, CustomScalars);
        const uint32 TotalScalars = UVScalars + CustomScalars;
        const uint32 MaxScalars = FMath::DivideAndRoundUp(TotalScalars, 4u) * 4;
        Stats->SetNumberField(TEXT("interpolators_used"), (double)TotalScalars);
        Stats->SetNumberField(TEXT("interpolators_max"), (double)MaxScalars);

        // Context echo. UMaterial::GetBlendModeString isn't exported to plugins;
        // EBlendMode is a UENUM, so resolve the name via reflection (linkable).
        FString BlendModeName = FString::Printf(TEXT("%d"), (int32)Mat->GetBlendMode());
        if (const UEnum* BlendEnum = StaticEnum<EBlendMode>())
            BlendModeName = BlendEnum->GetNameStringByValue((int64)Mat->GetBlendMode());
        Stats->SetStringField(TEXT("blend_mode"), BlendModeName);

        Out->SetObjectField(TEXT("stats"), Stats);
    }

    return FHaybaHandlerResult::Ok(Out);
}

// Task 4: material_disconnect — clear an input connection on a node or a
// material-output property connection. Mirrors material_connect_nodes in
// param shape; requires either to_node (+ optional to_input/to_input_index)
// or to_property.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDisconnect(const TSharedPtr<FJsonObject>& P)
{
    FString MatPath;
    if (!HaybaParams::GetString(P, TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_disconnect: missing material_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_disconnect: material not found"));

    FString ToNode, ToInput, PropStr;
    const bool bHasNode = P->TryGetStringField(TEXT("to_node"), ToNode);
    P->TryGetStringField(TEXT("to_input"), ToInput);
    const bool bHasProp = P->TryGetStringField(TEXT("to_property"), PropStr);

    if (!bHasNode && !bHasProp)
        return FHaybaHandlerResult::Err(TEXT("material_disconnect: missing to_node or to_property"));

    if (bHasProp)
    {
        // Disconnect a material-output property (e.g. base_color, normal, etc.)
        EMaterialProperty Prop;
        if (!TryParseProperty(PropStr, Prop))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: unknown to_property: %s"), *PropStr));
        FExpressionInput* Input = Mat->GetExpressionInputForProperty(Prop);
        if (!Input)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: property has no ExpressionInput: %s"), *PropStr));
        Input->Expression = nullptr;
        Input->OutputIndex = 0;
    }
    else
    {
        // Disconnect a specific input pin on a node.
        UMaterialExpression* ToExpr = FindExprByName(Mat, ToNode);
        if (!ToExpr)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: to_node not found: %s"), *ToNode));

        // Find the matching input by name or index.
        int32 InputIndex = 0;
        int32 NamedIdx = INDEX_NONE;
        double IndexVal = 0.0;
        if (!ToInput.IsEmpty())
        {
            // Try named match first
            for (FExpressionInputIterator It{ToExpr}; It; ++It)
            {
                if (!It->InputName.IsNone() && It->InputName.ToString().Equals(ToInput, ESearchCase::IgnoreCase))
                { NamedIdx = InputIndex; break; }
                ++InputIndex;
            }
        }
        else if (P->TryGetNumberField(TEXT("to_input_index"), IndexVal))
        {
            NamedIdx = (int32)IndexVal;
        }
        else
        {
            NamedIdx = 0; // default: first input
        }

        // Walk to NamedIdx and clear
        int32 Cur = 0;
        bool bCleared = false;
        for (FExpressionInputIterator It{ToExpr}; It; ++It)
        {
            if (Cur == NamedIdx)
            {
                It->Expression = nullptr;
                It->OutputIndex = 0;
                bCleared = true;
                break;
            }
            ++Cur;
        }
        if (!bCleared)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: input index %d out of range on %s"), NamedIdx, *ToNode));
    }

    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("disconnected"), true);
    return FHaybaHandlerResult::Ok(Out);
}
