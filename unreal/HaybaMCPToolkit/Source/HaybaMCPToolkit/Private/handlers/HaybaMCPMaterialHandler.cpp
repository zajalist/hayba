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
#include "Engine/TextureCollection.h"
#include "Engine/Font.h"
#include "Engine/World.h"
#include "Misc/PackageName.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UnrealType.h"
#include "UObject/EnumProperty.h"
// Graph authoring (Tasks 2-4): connections, node properties, material functions
#include "MaterialEditingLibrary.h"
#include "Materials/MaterialAttributeDefinitionMap.h"
#include "Materials/MaterialParameterCollection.h"
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
// down on an invalid intermediate graph. Instead each successful graph edit
// stays dirty in memory. The explicit, guarded material_compile command is the
// single translate-and-save boundary; this prevents a half-built graph from
// being written to disk and crashing later during editor load/thumbnail work.
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

// Pure preflight for the reflection path below. HaybaReflection deliberately
// accepts many shapes, but several branches call AsNumber/AsString and nested
// structs/arrays can be partially written before a later element fails. A
// mutation handler must establish that the complete value is compatible before
// the expression is created or the live expression is touched.
static bool IsFiniteJsonNumber(const TSharedPtr<FJsonValue>& V, double* Out = nullptr)
{
    double N = 0.0;
    if (!V.IsValid() || !V->TryGetNumber(N) || !FMath::IsFinite(N)) return false;
    if (Out) *Out = N;
    return true;
}

static bool ValidateFiniteNumberArray(
    const TSharedPtr<FJsonValue>& V,
    int32 MinItems,
    int32 MaxItems,
    FString& OutReason)
{
    if (!V.IsValid() || V->Type != EJson::Array)
    {
        OutReason = TEXT("must be an array of finite numbers");
        return false;
    }
    const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
    if (A.Num() < MinItems || A.Num() > MaxItems)
    {
        OutReason = FString::Printf(TEXT("must contain %d..%d numbers"), MinItems, MaxItems);
        return false;
    }
    for (int32 Index = 0; Index < A.Num(); ++Index)
    {
        if (!IsFiniteJsonNumber(A[Index]))
        {
            OutReason = FString::Printf(TEXT("element %d must be a finite number"), Index);
            return false;
        }
    }
    return true;
}

static bool ValidateJsonForProperty(
    FProperty* Prop,
    const TSharedPtr<FJsonValue>& V,
    FString& OutReason,
    int32 Depth = 0)
{
    if (Depth > 32)
    {
        OutReason = TEXT("exceeds the 32-level mutation depth limit");
        return false;
    }
    if (!Prop || !V.IsValid())
    {
        OutReason = TEXT("property/value is null");
        return false;
    }
    if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
    {
        (void)B;
        if (V->Type == EJson::Boolean || IsFiniteJsonNumber(V)) return true;
        OutReason = TEXT("must be a boolean or finite number");
        return false;
    }
    if (FByteProperty* Byte = CastField<FByteProperty>(Prop))
    {
        if (V->Type == EJson::String && Byte->Enum)
        {
            int64 EnumValue = Byte->Enum->GetValueByNameString(V->AsString());
            if (EnumValue == INDEX_NONE)
            {
                const FString First = Byte->Enum->GetNameStringByIndex(0);
                int32 Underscore = INDEX_NONE;
                if (First.FindChar('_', Underscore))
                    EnumValue = Byte->Enum->GetValueByNameString(
                        First.Left(Underscore) + TEXT("_") + V->AsString());
            }
            if (EnumValue != INDEX_NONE) return true;
            OutReason = TEXT("is not a valid enum value");
            return false;
        }
        double N = 0.0;
        if (IsFiniteJsonNumber(V, &N) && FMath::FloorToDouble(N) == N && N >= 0.0 && N <= 255.0) return true;
        OutReason = TEXT("must be an integer byte value");
        return false;
    }
    if (FEnumProperty* EnumProp = CastField<FEnumProperty>(Prop))
    {
        if (V->Type == EJson::String && EnumProp->GetEnum())
        {
            const UEnum* Enum = EnumProp->GetEnum();
            const FString Raw = V->AsString();
            if (Enum->GetValueByNameString(Raw) != INDEX_NONE
                || Enum->GetValueByNameString(Enum->GetName() + TEXT("::") + Raw) != INDEX_NONE)
                return true;
            OutReason = TEXT("is not a valid enum value");
            return false;
        }
        double N = 0.0;
        if (IsFiniteJsonNumber(V, &N) && FMath::FloorToDouble(N) == N) return true;
        OutReason = TEXT("must be an enum name or integer value");
        return false;
    }
    if (FNumericProperty* Number = CastField<FNumericProperty>(Prop))
    {
        double N = 0.0;
        if (!IsFiniteJsonNumber(V, &N))
        {
            OutReason = TEXT("must be a finite number");
            return false;
        }
        if (Number->IsInteger() && FMath::FloorToDouble(N) != N)
        {
            OutReason = TEXT("must be an integer");
            return false;
        }
        return true;
    }
    if (CastField<FNameProperty>(Prop) || CastField<FStrProperty>(Prop) || CastField<FTextProperty>(Prop))
    {
        if (V->Type == EJson::String) return true;
        OutReason = TEXT("must be a string");
        return false;
    }
    if (FObjectProperty* ObjectProp = CastField<FObjectProperty>(Prop))
    {
        if (V->Type == EJson::Null) return true;
        UObject* Object = HaybaReflection::ResolveObjectRef(V);
        if (Object && Object->IsA(ObjectProp->PropertyClass)) return true;
        OutReason = FString::Printf(TEXT("must resolve to a %s object"), *ObjectProp->PropertyClass->GetName());
        return false;
    }
    if (FStructProperty* StructProp = CastField<FStructProperty>(Prop))
    {
        if (V->Type == EJson::String) return true; // ImportText_Direct validates during staging.
        if (V->Type == EJson::Object)
        {
            if (V->AsObject()->Values.Num() == 0)
            {
                OutReason = TEXT("struct object must contain at least one field");
                return false;
            }
            if (V->AsObject()->Values.Num() > 256)
            {
                OutReason = TEXT("struct object exceeds the 256-field mutation limit");
                return false;
            }
            for (const auto& Pair : V->AsObject()->Values)
            {
                FProperty* Field = StructProp->Struct->FindPropertyByName(FName(*FString(*Pair.Key)));
                FString Nested;
                if (!Field || !ValidateJsonForProperty(Field, Pair.Value, Nested, Depth + 1))
                {
                    OutReason = FString::Printf(TEXT("struct field '%s' %s"), *FString(*Pair.Key), *Nested);
                    return false;
                }
            }
            return true;
        }
        const FString StructName = StructProp->Struct->GetName();
        int32 Min = 0, Max = 0;
        if (StructName == TEXT("Vector") || StructName == TEXT("LinearColor") || StructName == TEXT("SlateColor") || StructName == TEXT("Color")) { Min = 3; Max = 4; }
        else if (StructName == TEXT("Vector4") || StructName == TEXT("Vector4f")) { Min = 4; Max = 4; }
        else if (StructName == TEXT("Vector2D")) { Min = 2; Max = 2; }
        else if (StructName == TEXT("Margin")) { Min = 1; Max = 4; }
        if (Min > 0) return ValidateFiniteNumberArray(V, Min, Max, OutReason);
        OutReason = TEXT("must be a supported struct string/object shape");
        return false;
    }
    if (FArrayProperty* ArrayProp = CastField<FArrayProperty>(Prop))
    {
        if (V->Type != EJson::Array)
        {
            OutReason = TEXT("must be an array");
            return false;
        }
        if (V->AsArray().Num() > 1024)
        {
            OutReason = TEXT("array exceeds the 1024-item mutation limit");
            return false;
        }
        for (int32 Index = 0; Index < V->AsArray().Num(); ++Index)
        {
            FString Nested;
            if (!ValidateJsonForProperty(ArrayProp->Inner, V->AsArray()[Index], Nested, Depth + 1))
            {
                OutReason = FString::Printf(TEXT("array element %d %s"), Index, *Nested);
                return false;
            }
        }
        return true;
    }

    OutReason = FString::Printf(TEXT("uses unsupported property type %s"), *Prop->GetCPPType());
    return false;
}

static bool PreflightNodeProps(
    UClass* ExprClass,
    const TSharedPtr<FJsonObject>& Props,
    TArray<FString>& OutProblems)
{
    if (!Props.IsValid()) return true;
    if (Props->Values.Num() > 256)
    {
        OutProblems.Add(TEXT("properties exceeds the 256-field mutation limit"));
        return false;
    }
    if (!ExprClass || !ExprClass->IsChildOf<UMaterialExpression>())
    {
        OutProblems.Add(TEXT("expression class is not a UMaterialExpression"));
        return false;
    }

    static const TSet<FString> Aliases = {
        TEXT("parameter_name"), TEXT("default_value"), TEXT("texture"),
        TEXT("const"), TEXT("function"), TEXT("function_path"),
        TEXT("coordinate_index"), TEXT("u_tiling"), TEXT("v_tiling"),
    };

    if (Props->HasField(TEXT("function")) && Props->HasField(TEXT("function_path")))
        OutProblems.Add(TEXT("properties.function and properties.function_path are aliases; pass only one"));

    for (const auto& Pair : Props->Values)
    {
        const FString Key(*Pair.Key);
        FString Reason;
        bool bValid = false;

        if (Key == TEXT("parameter_name"))
        {
            bValid = Pair.Value.IsValid() && Pair.Value->Type == EJson::String
                && !Pair.Value->AsString().IsEmpty()
                && (ExprClass->IsChildOf<UMaterialExpressionParameter>()
                    || ExprClass->IsChildOf<UMaterialExpressionTextureSampleParameter>()
                    || ExprClass->IsChildOf<UMaterialExpressionFunctionInput>()
                    || ExprClass->IsChildOf<UMaterialExpressionFunctionOutput>());
            Reason = TEXT("must be a non-empty string on a parameter/input/output expression");
        }
        else if (Key == TEXT("default_value"))
        {
            if (ExprClass->IsChildOf<UMaterialExpressionScalarParameter>())
                bValid = IsFiniteJsonNumber(Pair.Value);
            else if (ExprClass->IsChildOf<UMaterialExpressionStaticBoolParameter>())
                bValid = Pair.Value.IsValid() && Pair.Value->Type == EJson::Boolean;
            else if (ExprClass->IsChildOf<UMaterialExpressionVectorParameter>())
                bValid = ValidateFiniteNumberArray(Pair.Value, 3, 4, Reason);
            Reason = Reason.IsEmpty() ? TEXT("does not match this parameter expression's value type") : Reason;
        }
        else if (Key == TEXT("texture"))
        {
            FString Path;
            bValid = ExprClass->IsChildOf<UMaterialExpressionTextureBase>()
                && Pair.Value.IsValid() && Pair.Value->TryGetString(Path)
                && !Path.IsEmpty() && LoadObject<UTexture>(nullptr, *Path) != nullptr;
            Reason = TEXT("must name an existing texture for a texture expression");
        }
        else if (Key == TEXT("const"))
        {
            if (ExprClass->IsChildOf<UMaterialExpressionConstant>())
                bValid = IsFiniteJsonNumber(Pair.Value);
            else
            {
                const int32 Exact = ExprClass->IsChildOf<UMaterialExpressionConstant2Vector>() ? 2
                    : ExprClass->IsChildOf<UMaterialExpressionConstant3Vector>() ? 3
                    : ExprClass->IsChildOf<UMaterialExpressionConstant4Vector>() ? 4 : 0;
                bValid = Exact > 0 && ValidateFiniteNumberArray(Pair.Value, Exact, Exact, Reason);
            }
            Reason = Reason.IsEmpty() ? TEXT("does not match this constant expression's arity") : Reason;
        }
        else if (Key == TEXT("function") || Key == TEXT("function_path"))
        {
            FString Path;
            bValid = ExprClass->IsChildOf<UMaterialExpressionMaterialFunctionCall>()
                && Pair.Value.IsValid() && Pair.Value->TryGetString(Path)
                && !Path.IsEmpty() && LoadObject<UMaterialFunction>(nullptr, *Path) != nullptr;
            Reason = TEXT("must name an existing material function on a MaterialFunctionCall expression");
        }
        else if (Key == TEXT("coordinate_index"))
        {
            double N = 0.0;
            bValid = ExprClass->IsChildOf<UMaterialExpressionTextureCoordinate>()
                && IsFiniteJsonNumber(Pair.Value, &N)
                && FMath::FloorToDouble(N) == N && N >= 0.0 && N <= MAX_int32;
            Reason = TEXT("must be a non-negative 32-bit integer on a TextureCoordinate expression");
        }
        else if (Key == TEXT("u_tiling") || Key == TEXT("v_tiling"))
        {
            bValid = ExprClass->IsChildOf<UMaterialExpressionTextureCoordinate>()
                && IsFiniteJsonNumber(Pair.Value);
            Reason = TEXT("must be a finite number on a TextureCoordinate expression");
        }
        else
        {
            FProperty* Prop = ExprClass->FindPropertyByName(FName(*Key));
            bValid = Prop && Prop->HasAnyPropertyFlags(CPF_Edit)
                && !Prop->HasAnyPropertyFlags(CPF_EditConst | CPF_Transient | CPF_Deprecated)
                && ValidateJsonForProperty(Prop, Pair.Value, Reason);
            if (!Prop) Reason = TEXT("is not a property on this expression class");
        }

        if (!bValid)
            OutProblems.Add(FString::Printf(TEXT("properties.%s %s"), *Key, *Reason));
    }
    return OutProblems.Num() == 0;
}

static TArray<double> ReadFiniteNumberArray(
    FHaybaParamReader& R,
    const TCHAR* Key,
    int32 MinItems,
    int32 MaxItems,
    bool& bOutPresent)
{
    TArray<double> Out;
    bOutPresent = R.Raw().IsValid() && R.Raw()->HasField(Key);
    if (!bOutPresent) return Out;

    const TArray<TSharedPtr<FJsonValue>>* Values = R.OptionalArray(Key, MaxItems);
    if (!Values) return Out;
    if (Values->Num() < MinItems || Values->Num() > MaxItems)
    {
        R.AddError(FString::Printf(
            TEXT("'%s' must contain %d..%d finite numbers"), Key, MinItems, MaxItems));
        return Out;
    }
    for (int32 Index = 0; Index < Values->Num(); ++Index)
    {
        double Number = 0.0;
        if (!(*Values)[Index].IsValid()
            || !(*Values)[Index]->TryGetNumber(Number)
            || !FMath::IsFinite(Number))
        {
            R.AddError(FString::Printf(
                TEXT("'%s' element %d must be a finite number"), Key, Index));
            Out.Reset();
            return Out;
        }
        Out.Add(Number);
    }
    return Out;
}

static void ValidateIntegerArrayRange(
    FHaybaParamReader& R,
    const TCHAR* Key,
    const TArray<double>& Values,
    bool bPresent,
    int32 Min,
    int32 Max)
{
    if (!bPresent || Values.Num() == 0) return;
    for (int32 Index = 0; Index < Values.Num(); ++Index)
    {
        const double Value = Values[Index];
        if (FMath::FloorToDouble(Value) != Value || Value < Min || Value > Max)
        {
            R.AddError(FString::Printf(
                TEXT("'%s' element %d must be an integer between %d and %d"),
                Key, Index, Min, Max));
        }
    }
}

static void ValidateNumberArrayRange(
    FHaybaParamReader& R,
    const TCHAR* Key,
    const TArray<double>& Values,
    bool bPresent,
    double Min,
    double Max)
{
    if (!bPresent || Values.Num() == 0) return;
    for (int32 Index = 0; Index < Values.Num(); ++Index)
    {
        if (Values[Index] < Min || Values[Index] > Max)
        {
            R.AddError(FString::Printf(
                TEXT("'%s' element %d must be between %.17g and %.17g"),
                Key, Index, Min, Max));
        }
    }
}

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

    // Do not broadcast PostEditChange for every staged node edit. Some editor
    // delegates compile/refresh material graphs from that notification and a
    // stale delegate can AV the process. The owning material/function is dirty;
    // material_compile is the single guarded broadcast/compile boundary.
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
    FHaybaParamReader ParamR(P, TEXT("material_create"));
    const FString PkgPath = ParamR.RequiredString(TEXT("package_path"));
    const FString Name = ParamR.RequiredString(TEXT("name"), 256);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // package_path may be the target directory OR the full asset path — see
    // material_function_create for the rationale. Backward-compatible: when the
    // last segment already equals Name (the documented full-path convention) this
    // strips it exactly as before; a bare directory now lands correctly too.
    const FString Dir = (FPackageName::GetShortName(PkgPath) == Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    const FString TargetPackage = Dir / Name;
    if (!TargetPackage.StartsWith(TEXT("/Game/"))
        || !FPackageName::IsValidLongPackageName(TargetPackage))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_create: target must be a valid package under /Game; resolved '%s'. Nothing was created."),
            *TargetPackage));
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_create"), Dir, Name));
    }

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
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
    Out->SetBoolField(TEXT("dirty"), Created->GetOutermost()->IsDirty());
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatFunctionCreate(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_function_create"));
    const FString PkgPath = ParamR.RequiredString(TEXT("package_path"));
    const FString Name = ParamR.RequiredString(TEXT("name"), 256);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

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
    const FString TargetPackage = Dir / Name;
    if (!TargetPackage.StartsWith(TEXT("/Game/"))
        || !FPackageName::IsValidLongPackageName(TargetPackage))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_function_create: target must be a valid package under /Game; resolved '%s'. Nothing was created."),
            *TargetPackage));
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_function_create"), Dir, Name));
    }

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFunctionFactoryNew* Factory = NewObject<UMaterialFunctionFactoryNew>();
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
    Out->SetBoolField(TEXT("dirty"), Created->GetOutermost()->IsDirty());
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

// Prefer UE's public output pin metadata, but recover the authoritative name
// from a material-function call when GetOutputs() is stale/unnamed. The output
// index remains the hard identity; output_N is only a deterministic label for
// genuinely unnamed single-output expressions.
static FString HaybaExpressionOutputName(UMaterialExpression* Expr, int32 OutputIndex)
{
    if (!Expr || OutputIndex < 0) return FString();
    const TArray<FExpressionOutput>& Outputs = Expr->GetOutputs();
    if (Outputs.IsValidIndex(OutputIndex))
    {
        const FExpressionOutput& Output = Outputs[OutputIndex];
        if (!Output.OutputName.IsNone()) return Output.OutputName.ToString();
        if (const UMaterialExpressionMaterialFunctionCall* Call = Cast<UMaterialExpressionMaterialFunctionCall>(Expr))
            if (Call->FunctionOutputs.IsValidIndex(OutputIndex) && !Call->FunctionOutputs[OutputIndex].Output.OutputName.IsNone())
                return Call->FunctionOutputs[OutputIndex].Output.OutputName.ToString();
        if (Output.Mask)
        {
            if (Output.MaskR && !Output.MaskG && !Output.MaskB && !Output.MaskA) return TEXT("R");
            if (!Output.MaskR && Output.MaskG && !Output.MaskB && !Output.MaskA) return TEXT("G");
            if (!Output.MaskR && !Output.MaskG && Output.MaskB && !Output.MaskA) return TEXT("B");
            if (!Output.MaskR && !Output.MaskG && !Output.MaskB && Output.MaskA) return TEXT("A");
        }
    }
    return FString();
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString ExprClass, MatPath, FuncPath;
    FHaybaParamReader ParamR(P, TEXT("material_add_node"));
    ExprClass = ParamR.RequiredString(TEXT("expression_class"));
    MatPath = ParamR.OptionalString(TEXT("material_path"));
    FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const TSharedPtr<FJsonObject> PropsObj = ParamR.OptionalObject(TEXT("properties"), 128);
    bool bHasPos = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UClass* ExprCls = FindFirstObjectSafe<UClass>(*ExprClass);
    if (!ExprCls) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_node: class not found: %s"), *ExprClass));
    if (!ExprCls->IsChildOf<UMaterialExpression>() || ExprCls->HasAnyClassFlags(CLASS_Abstract))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_add_node: '%s' is not a concrete material-expression class; nothing was created"), *ExprClass));

    TArray<FString> PropertyProblems;
    if (!PreflightNodeProps(ExprCls, PropsObj, PropertyProblems))
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_add_node: property preflight failed: %s. Nothing was created or dirtied."),
            *FString::Join(PropertyProblems, TEXT("; "))));
    }

    int32 X = bHasPos ? static_cast<int32>(Pos[0]) : 0;
    int32 Y = bHasPos ? static_cast<int32>(Pos[1]) : 0;

    // Material-Function target (Task 4) takes precedence when supplied.
    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_node: function not found"));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        Fn->Modify();
        UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, ExprCls, X, Y);
        if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpressionInFunction failed"));
        FApplyNodePropsResult PR;
        if (PropsObj.IsValid()) PR = ApplyNodeProps(Expr, PropsObj);
        // Do not compile/broadcast from an edit command. UpdateMaterialFunction
        // is crash-prone in the presence of stale editor delegates and belongs
        // only to the guarded material_compile(function_path) boundary.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), Expr->GetName());
        Out->SetBoolField(TEXT("verified"), FindExprByNameInFunction(Fn, Expr->GetName()) == Expr);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        EmitFunctionCallOutputs(Expr, Out.ToSharedRef());
        AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_add_node"));
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_node: material not found"));

    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    Mat->Modify();
    UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpression(Mat, ExprCls, X, Y);
    if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpression failed"));
    FApplyNodePropsResult PR;
    if (PropsObj.IsValid()) PR = ApplyNodeProps(Expr, PropsObj);
    // Deferred compile: no per-edit RecompileMaterial or save. Keep the
    // half-built graph dirty in memory until guarded material_compile validates,
    // translates, verifies, and writes it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), Expr->GetName());
    Out->SetBoolField(TEXT("verified"), FindExprByName(Mat, Expr->GetName()) == Expr);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
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
    {
        const FString Name = HaybaExpressionOutputName(From, i);
        Names.Add(FString::Printf(TEXT("[%d] %s"), i, Name.IsEmpty() ? TEXT("(unnamed; use index)") : *Name));
    }
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
        if (HaybaExpressionOutputName(From, i).Equals(Name, ESearchCase::IgnoreCase)) return i;
    TArray<FString> Avail;
    for (int32 i = 0; i < Outs.Num(); ++i)
    {
        const FString Nm = HaybaExpressionOutputName(From, i);
        Avail.Add(FString::Printf(TEXT("[%d] %s"), i, Nm.IsEmpty() ? TEXT("(unnamed; use from_output_index)") : *Nm));
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
    FString FromNode, FromOutput, ToNode, ToInput, PropStr, FuncPath, MatPath;
    FHaybaParamReader ParamR(P, TEXT("material_connect_nodes"));
    FromNode = ParamR.RequiredString(TEXT("from_node"));
    FromOutput = ParamR.OptionalString(TEXT("from_output"));
    ToNode = ParamR.OptionalString(TEXT("to_node"));
    ToInput = ParamR.OptionalString(TEXT("to_input"));
    PropStr = ParamR.OptionalString(TEXT("to_property"));
    FuncPath = ParamR.OptionalString(TEXT("function_path"));
    MatPath = ParamR.OptionalString(TEXT("material_path"));
    const bool bHasFromOutputIndex = ParamR.Raw().IsValid()
        && ParamR.Raw()->HasField(TEXT("from_output_index"));
    const int32 FromOutputIndex = ParamR.OptionalIntInRange(TEXT("from_output_index"), 0, 0, 1023);
    const bool bHasToInputIndex = ParamR.Raw().IsValid()
        && ParamR.Raw()->HasField(TEXT("to_input_index"));
    const int32 ToInputIndex = ParamR.OptionalIntInRange(TEXT("to_input_index"), -1, 0, 1023);
    const bool bHasTo = !ToNode.IsEmpty();
    const bool bHasProp = !PropStr.IsEmpty();
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (bHasTo == bHasProp)
        ParamR.AddError(TEXT("pass exactly one target: 'to_node' or 'to_property'"));
    if (!FuncPath.IsEmpty() && bHasProp)
        ParamR.AddError(TEXT("function graph connections require 'to_node'; 'to_property' belongs to master materials"));
    if (bHasToInputIndex && !ToInput.IsEmpty())
        ParamR.AddError(TEXT("'to_input' and 'to_input_index' are mutually exclusive"));
    if (bHasFromOutputIndex && !FromOutput.IsEmpty())
        ParamR.AddError(TEXT("'from_output' and 'from_output_index' are mutually exclusive"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // Material-Function target (Task 4).
    if (!FuncPath.IsEmpty())
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
            Fn->Modify();
            In->Connect(FromIdx, From); // index-resolved — never silently output 0
            if (In->Expression != From || In->OutputIndex != FromIdx)
                return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: connection write did not survive readback; function graph state is unknown — inspect material_get_info before retrying"));
        }
        // Staged only; material_compile(function_path) performs the guarded
        // UpdateMaterialFunction and persistence step.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("connected"), true);
        Out->SetBoolField(TEXT("verified"), true);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Out);
    }

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
    FExpressionInput* TargetInput = nullptr;
    if (bHasProp)
    {
        EMaterialProperty Prop;
        if (!TryParseProperty(PropStr, Prop))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: unknown to_property: %s"), *PropStr));
        TargetInput = Mat->GetExpressionInputForProperty(Prop);
        if (!TargetInput) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: material property '%s' has no input (material attributes in use?)"), *PropStr));
    }
    else
    {
        if (!bHasTo) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing to_node or to_property"));
        To = FindExprByName(Mat, ToNode);
        if (!To) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_node not found: %s"), *ToNode));
        TargetInput = ResolveToInput(To, ToInput, ToInputIndex);
        if (!TargetInput) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_input '%s' (index %d) not found on '%s'"), *ToInput, ToInputIndex, *ToNode));
    }

    Mat->Modify();
    TargetInput->Connect(FromIdx, From); // index-resolved — never silently output 0
    const bool bVerified = TargetInput->Expression == From
        && TargetInput->OutputIndex == FromIdx;

    // Deferred compile: keep the staged graph dirty in memory until the guarded
    // material_compile boundary validates and saves it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("connected"), true);
    Out->SetBoolField(TEXT("verified"), bVerified);
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("The connection write did not survive readback. Inspect material_get_info before retrying; the graph outcome is unknown."));
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());

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
    FHaybaParamReader ParamR(P, TEXT("material_create_instance"));
    const FString ParentPath = ParamR.RequiredString(TEXT("parent_material_path"));
    const FString PkgPath = ParamR.RequiredString(TEXT("package_path"));
    const FString Name = ParamR.RequiredString(TEXT("name"), 256);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // package_path may be the target directory OR the full asset path — see
    // material_function_create. Backward-compatible with the full-path convention.
    const FString Dir = (FPackageName::GetShortName(PkgPath) == Name)
        ? FPackageName::GetLongPackagePath(PkgPath)
        : PkgPath;
    const FString TargetPackage = Dir / Name;
    if (!TargetPackage.StartsWith(TEXT("/Game/"))
        || !FPackageName::IsValidLongPackageName(TargetPackage))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_create_instance: target must be a valid package under /Game; resolved '%s'. Nothing was created."),
            *TargetPackage));
    // Refuse a taken name instead of letting CreateAsset raise a modal
    // overwrite dialog, which would block the game thread and hang every
    // queued MCP request. See HaybaMCPAssetGuard.h.
    if (HaybaAssetGuard::AssetNameTaken(Dir, Name))
    {
        return FHaybaHandlerResult::Err(
            HaybaAssetGuard::NameTakenError(TEXT("material_create_instance"), Dir, Name));
    }

    UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr, *ParentPath);
    if (!Parent) return FHaybaHandlerResult::Err(TEXT("material_create_instance: parent material not found"));

    UMaterialInstanceConstantFactoryNew* Factory = NewObject<UMaterialInstanceConstantFactoryNew>();
    Factory->InitialParent = Parent;
    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterialInstanceConstant::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_create_instance: CreateAsset failed"));

    // Persist immediately (see material_create) so the instance survives a crash
    // before its first parameter is set.
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Created, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetBoolField(TEXT("saved"), bSaved);
    Out->SetBoolField(TEXT("dirty"), Created->GetOutermost()->IsDirty());
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetParam(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_set_param"));
    const FString InstPath = ParamR.RequiredString(TEXT("instance_path"));
    const FString ParamName = ParamR.RequiredString(TEXT("param_name"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UMaterialInstanceConstant* MIC = LoadObject<UMaterialInstanceConstant>(nullptr, *InstPath);
    if (!MIC) return FHaybaHandlerResult::Err(TEXT("material_set_param: instance not found"));

    TSharedPtr<FJsonValue> Val = P->TryGetField(TEXT("value"));
    if (!Val.IsValid()) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing value"));

    FName PName(*ParamName);
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("param"), ParamName);
    bool bVerified = false;

    // Honesty: the ...EditorOnly setters silently register an override for a
    // misspelled/nonexistent parameter and return void. Verify the parameter
    // actually exists in the material hierarchy first (bOverriddenOnly=false so
    // the default counts as "exists"), otherwise the caller would believe a real
    // parameter changed when nothing was affected.
    const FMaterialParameterInfo ParamInfo(PName);

    if (Val->Type == EJson::Number)
    {
        double RequestedScalar = 0.0;
        if (!IsFiniteJsonNumber(Val, &RequestedScalar))
            return FHaybaHandlerResult::Err(TEXT("material_set_param: scalar value must be finite; nothing was changed"));
        float ExistingScalar = 0.f;
        if (!MIC->GetScalarParameterValue(ParamInfo, ExistingScalar, /*bOveriddenOnly=*/false))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: scalar parameter '%s' does not exist on this material"), *ParamName));
        MIC->Modify();
        MIC->SetScalarParameterValueEditorOnly(PName, static_cast<float>(RequestedScalar));
        float ObservedScalar = 0.f;
        bVerified = MIC->GetScalarParameterValue(ParamInfo, ObservedScalar, false)
            && FMath::IsNearlyEqual(ObservedScalar, static_cast<float>(RequestedScalar));
        Out->SetNumberField(TEXT("value"), RequestedScalar);
        Out->SetNumberField(TEXT("observed_value"), ObservedScalar);
    }
    else if (Val->Type == EJson::Array)
    {
        FLinearColor ExistingVec;
        if (!MIC->GetVectorParameterValue(ParamInfo, ExistingVec, /*bOveriddenOnly=*/false))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: vector parameter '%s' does not exist on this material"), *ParamName));
        const TArray<TSharedPtr<FJsonValue>>& Arr = Val->AsArray();
        FString ShapeError;
        if (!ValidateFiniteNumberArray(Val, 3, 4, ShapeError))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_param: vector value %s; nothing was changed"), *ShapeError));
        FLinearColor C(Arr[0]->AsNumber(), Arr[1]->AsNumber(), Arr[2]->AsNumber(),
            Arr.Num() > 3 ? Arr[3]->AsNumber() : 1.0);
        MIC->Modify();
        MIC->SetVectorParameterValueEditorOnly(PName, C);
        FLinearColor Observed;
        bVerified = MIC->GetVectorParameterValue(ParamInfo, Observed, false)
            && Observed.Equals(C);
        Out->SetStringField(TEXT("value"), C.ToString());
        Out->SetStringField(TEXT("observed_value"), Observed.ToString());
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
        MIC->Modify();
        MIC->SetTextureParameterValueEditorOnly(PName, Tex);
        UTexture* ObservedTexture = nullptr;
        bVerified = MIC->GetTextureParameterValue(ParamInfo, ObservedTexture, false)
            && ObservedTexture == Tex;
        Out->SetStringField(TEXT("value"), TexPath);
        Out->SetStringField(TEXT("observed_value"), ObservedTexture ? ObservedTexture->GetPathName() : FString());
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
        MIC->Modify();
        MIC->UpdateStaticPermutation(StaticParams);
        FStaticParameterSet ObservedParams;
        MIC->GetStaticParameterValues(ObservedParams);
        for (const FStaticSwitchParameter& SP : ObservedParams.StaticSwitchParameters)
            if (SP.ParameterInfo.Name == PName) { bVerified = SP.Value == bSwitch; break; }
        Out->SetBoolField(TEXT("value"), bSwitch);
    }
    else return FHaybaHandlerResult::Err(TEXT("material_set_param: unsupported value type"));

    // Instances carry no master graph, so PostEditChange here only updates the
    // instance permutation (no assert-prone translate); keep it, then persist
    // to disk so the param survives a later crash.
    MIC->PostEditChange();
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(MIC, SaveErr);
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetBoolField(TEXT("saved"), bSaved);
    Out->SetBoolField(TEXT("dirty"), MIC->GetOutermost()->IsDirty());
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("The parameter setter returned but readback did not match. Inspect observed_value before retrying."));
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatApply(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_apply"));
    const FString ActorId = ParamR.RequiredString(TEXT("actor_id"));
    const FString MatPath = ParamR.RequiredString(TEXT("material_path"));
    const int32 SlotIndex = ParamR.OptionalIntInRange(TEXT("slot_index"), 0, 0, 1023);
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World) return FHaybaHandlerResult::Err(TEXT("material_apply: no current editor world; nothing was changed"));
    AActor* Actor = FindActorInWorld(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_apply: actor not found: %s"), *ActorId));

    UMaterialInterface* Mat = LoadObject<UMaterialInterface>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_apply: material not found"));

    UStaticMeshComponent* SMC = Actor->FindComponentByClass<UStaticMeshComponent>();
    if (!SMC) return FHaybaHandlerResult::Err(TEXT("material_apply: actor has no StaticMeshComponent"));
    const int32 SlotCount = SMC->GetNumMaterials();
    if (SlotIndex >= SlotCount)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_apply: slot_index %d is out of range for '%s' (%d material slot(s)); nothing was changed"),
            SlotIndex, *ActorId, SlotCount));

    const bool bAlreadyApplied = SMC->GetMaterial(SlotIndex) == Mat;
    if (!bAlreadyApplied)
    {
        SMC->Modify();
        SMC->SetMaterial(SlotIndex, Mat);
        SMC->MarkRenderStateDirty();
        Actor->MarkPackageDirty();
    }
    const bool bVerified = SMC->GetMaterial(SlotIndex) == Mat;

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetNumberField(TEXT("slot_index"), SlotIndex);
    Out->SetBoolField(TEXT("applied"), !bAlreadyApplied);
    Out->SetBoolField(TEXT("already_applied"), bAlreadyApplied);
    Out->SetBoolField(TEXT("verified"), bVerified);
    Out->SetBoolField(TEXT("dirty"), Actor->GetOutermost()->IsDirty());
    if (!bVerified)
        Out->SetStringField(TEXT("warning"), TEXT("SetMaterial returned but readback did not match; inspect the component before retrying."));
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

        // Parameter identity and authored default belong to the expression,
        // not to a future material instance.  Omitting them forced callers to
        // infer names from captions/classes and made a graph audit unable to
        // distinguish two parameters of the same type.  Use the expression's
        // virtual metadata seam so engine and plugin-defined parameter nodes
        // participate without a growing cast list.
        if (Expr->HasAParameterName())
        {
            const FName ParameterName = Expr->GetParameterName();
            const bool bParameterNameValid = ParameterName.IsValid() && !ParameterName.IsNone();
            if (!bParameterNameValid)
                Entry->SetField(TEXT("parameter_name"), MakeShared<FJsonValueNull>());
            else
                Entry->SetStringField(TEXT("parameter_name"), ParameterName.ToString());
            Entry->SetBoolField(TEXT("parameter_name_valid"), bParameterNameValid);

            FMaterialParameterMetadata Metadata;
            const bool bMetadataAvailable = Expr->GetParameterValue(Metadata);
            Entry->SetBoolField(TEXT("parameter_metadata_available"), bMetadataAvailable);

            FString ParameterType = TEXT("unknown");
            bool bDefaultAvailable = bMetadataAvailable;
            TSharedPtr<FJsonValue> DefaultValue = MakeShared<FJsonValueNull>();
            if (bMetadataAvailable)
            {
                switch (Metadata.Value.Type)
                {
                case EMaterialParameterType::Scalar:
                {
                    ParameterType = TEXT("scalar");
                    const float Value = Metadata.Value.AsScalar();
                    bDefaultAvailable = FMath::IsFinite(Value);
                    if (bDefaultAvailable) DefaultValue = MakeShared<FJsonValueNumber>(Value);
                    break;
                }
                case EMaterialParameterType::Vector:
                {
                    ParameterType = TEXT("vector");
                    const FLinearColor Value = Metadata.Value.AsLinearColor();
                    bDefaultAvailable = FMath::IsFinite(Value.R) && FMath::IsFinite(Value.G)
                        && FMath::IsFinite(Value.B) && FMath::IsFinite(Value.A);
                    if (bDefaultAvailable)
                    {
                        TArray<TSharedPtr<FJsonValue>> Components = {
                            MakeShared<FJsonValueNumber>(Value.R), MakeShared<FJsonValueNumber>(Value.G),
                            MakeShared<FJsonValueNumber>(Value.B), MakeShared<FJsonValueNumber>(Value.A),
                        };
                        DefaultValue = MakeShared<FJsonValueArray>(MoveTemp(Components));
                    }
                    break;
                }
                case EMaterialParameterType::DoubleVector:
                {
                    ParameterType = TEXT("double_vector");
                    const FVector4d Value = Metadata.Value.AsVector4d();
                    bDefaultAvailable = FMath::IsFinite(Value.X) && FMath::IsFinite(Value.Y)
                        && FMath::IsFinite(Value.Z) && FMath::IsFinite(Value.W);
                    if (bDefaultAvailable)
                    {
                        TArray<TSharedPtr<FJsonValue>> Components = {
                            MakeShared<FJsonValueNumber>(Value.X), MakeShared<FJsonValueNumber>(Value.Y),
                            MakeShared<FJsonValueNumber>(Value.Z), MakeShared<FJsonValueNumber>(Value.W),
                        };
                        DefaultValue = MakeShared<FJsonValueArray>(MoveTemp(Components));
                    }
                    break;
                }
                case EMaterialParameterType::Texture:
                    ParameterType = TEXT("texture");
                    if (UObject* Value = Metadata.Value.AsTextureObject())
                        DefaultValue = MakeShared<FJsonValueString>(Value->GetPathName());
                    break;
                case EMaterialParameterType::TextureCollection:
                    ParameterType = TEXT("texture_collection");
                    if (Metadata.Value.TextureCollection)
                        DefaultValue = MakeShared<FJsonValueString>(Metadata.Value.TextureCollection->GetPathName());
                    break;
                case EMaterialParameterType::RuntimeVirtualTexture:
                    ParameterType = TEXT("runtime_virtual_texture");
                    if (UObject* Value = Metadata.Value.AsTextureObject())
                        DefaultValue = MakeShared<FJsonValueString>(Value->GetPathName());
                    break;
                case EMaterialParameterType::SparseVolumeTexture:
                    ParameterType = TEXT("sparse_volume_texture");
                    if (UObject* Value = Metadata.Value.AsTextureObject())
                        DefaultValue = MakeShared<FJsonValueString>(Value->GetPathName());
                    break;
                case EMaterialParameterType::Font:
                {
                    ParameterType = TEXT("font");
                    TSharedPtr<FJsonObject> FontValue = MakeShared<FJsonObject>();
                    if (Metadata.Value.Font.Value)
                        FontValue->SetStringField(TEXT("asset"), Metadata.Value.Font.Value->GetPathName());
                    else
                        FontValue->SetField(TEXT("asset"), MakeShared<FJsonValueNull>());
                    FontValue->SetNumberField(TEXT("page"), Metadata.Value.Font.Page);
                    DefaultValue = MakeShared<FJsonValueObject>(FontValue.ToSharedRef());
                    break;
                }
                case EMaterialParameterType::StaticSwitch:
                    ParameterType = TEXT("static_switch");
                    DefaultValue = MakeShared<FJsonValueBoolean>(Metadata.Value.AsStaticSwitch());
                    break;
                case EMaterialParameterType::StaticComponentMask:
                {
                    ParameterType = TEXT("static_component_mask");
                    const FStaticComponentMaskValue Value = Metadata.Value.AsStaticComponentMask();
                    TSharedPtr<FJsonObject> Mask = MakeShared<FJsonObject>();
                    Mask->SetBoolField(TEXT("r"), Value.R);
                    Mask->SetBoolField(TEXT("g"), Value.G);
                    Mask->SetBoolField(TEXT("b"), Value.B);
                    Mask->SetBoolField(TEXT("a"), Value.A);
                    DefaultValue = MakeShared<FJsonValueObject>(Mask.ToSharedRef());
                    break;
                }
                case EMaterialParameterType::ParameterCollection:
                    ParameterType = TEXT("parameter_collection");
                    if (Metadata.Value.ParameterCollection)
                        DefaultValue = MakeShared<FJsonValueString>(Metadata.Value.ParameterCollection->GetPathName());
                    break;
                case EMaterialParameterType::None:
                case EMaterialParameterType::Num:
                default:
                    bDefaultAvailable = false;
                    break;
                }
            }

            Entry->SetStringField(TEXT("parameter_type"), ParameterType);
            Entry->SetBoolField(TEXT("default_value_available"), bDefaultAvailable);
            Entry->SetField(TEXT("default_value"), DefaultValue);
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
                const FString OutputName = HaybaExpressionOutputName(Expr, OutIdx);
                if (OutputName.IsEmpty()) OutEntry->SetField(TEXT("name"), MakeShared<FJsonValueNull>());
                else OutEntry->SetStringField(TEXT("name"), OutputName);
                OutEntry->SetStringField(TEXT("label"), OutputName.IsEmpty()
                    ? FString::Printf(TEXT("output_%d"), OutIdx) : OutputName);
                OutEntry->SetBoolField(TEXT("connect_by_name"), !OutputName.IsEmpty());
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
static const TMap<FString, EMaterialUsage>& HaybaMaterialUsageAliases();

// UE intentionally preserves individual property wires when Use Material
// Attributes is enabled so they can be restored later. Those stored wires are
// not compiler roots (except the engine's three explicit exceptions); treating
// them as live makes dead-node/reachability audits false-green.
static bool HaybaIsMaterialPropertyCompilerInputActive(const UMaterial* Mat, EMaterialProperty Property)
{
    if (!Mat) return false;
    if (Mat->bUseMaterialAttributes)
    {
        // CompilePropertyEx routes every semantic property (except these three
        // direct exceptions) through the single MaterialAttributes input. That
        // root remains real in non-surface domains even though asking whether
        // MP_MaterialAttributes itself is an active semantic property returns
        // false there.
        if (Property == MP_MaterialAttributes) return true;
        if (Property == MP_DiffuseColor || Property == MP_SpecularColor || Property == MP_FrontMaterial)
            return Mat->IsPropertyActiveInEditor(Property);
        return false;
    }
    return Property != MP_MaterialAttributes && Mat->IsPropertyActiveInEditor(Property);
}

// Exact terminal connections for the master material. Reachability alone says
// that a node is live; this map preserves both stored graph state and whether
// that terminal is currently considered by the compiler.
static TArray<TSharedPtr<FJsonValue>> SerializeMaterialOutputs(UMaterial* Mat)
{
    TArray<TSharedPtr<FJsonValue>> Outputs;
    if (!Mat) return Outputs;

    for (int32 PropertyIndex = 0; PropertyIndex < MP_MAX; ++PropertyIndex)
    {
        const EMaterialProperty Property = static_cast<EMaterialProperty>(PropertyIndex);
        FExpressionInput* Input = Mat->GetExpressionInputForProperty(Property);
        if (!Input) continue;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("property"), FMaterialAttributeDefinitionMap::GetAttributeName(Property));
        Entry->SetStringField(TEXT("display_name"), FMaterialAttributeDefinitionMap::GetDisplayNameForMaterial(Property, Mat).ToString());
        Entry->SetNumberField(TEXT("property_id"), PropertyIndex);
        Entry->SetBoolField(TEXT("connected"), Input->Expression != nullptr);
        const bool bCompilerInputActive = HaybaIsMaterialPropertyCompilerInputActive(Mat, Property);
        Entry->SetBoolField(TEXT("compiler_input_active"), bCompilerInputActive);
        Entry->SetBoolField(TEXT("connection_compiler_used"), bCompilerInputActive && Input->Expression != nullptr);
        if (Input->Expression)
        {
            Entry->SetStringField(TEXT("from_node"), Input->Expression->GetName());
            Entry->SetNumberField(TEXT("from_output"), Input->OutputIndex);
            const TArray<FExpressionOutput>& SourceOutputs = Input->Expression->GetOutputs();
            if (SourceOutputs.IsValidIndex(Input->OutputIndex))
            {
                const FString OutputName = HaybaExpressionOutputName(Input->Expression, Input->OutputIndex);
                if (OutputName.IsEmpty()) Entry->SetField(TEXT("from_output_name"), MakeShared<FJsonValueNull>());
                else Entry->SetStringField(TEXT("from_output_name"), OutputName);
                Entry->SetStringField(TEXT("from_output_label"), OutputName.IsEmpty()
                    ? FString::Printf(TEXT("output_%d"), Input->OutputIndex) : OutputName);
            }
            else
            {
                // Preserve corrupt/out-of-range graph evidence without
                // fabricating a pin name. material_validate reports the error.
                Entry->SetField(TEXT("from_output_name"), MakeShared<FJsonValueNull>());
                Entry->SetField(TEXT("from_output_label"), MakeShared<FJsonValueNull>());
            }
        }
        Outputs.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }
    return Outputs;
}

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
        Out->SetBoolField(TEXT("uses_material_attributes"), Mat->bUseMaterialAttributes);
        Out->SetArrayField(TEXT("expressions"), SerializeMaterialExpressions(Mat->GetExpressions(), &Consumed, &Reachable));
        Out->SetArrayField(TEXT("material_outputs"), SerializeMaterialOutputs(Mat));
        Out->SetArrayField(TEXT("dead_nodes"), CollectDeadNodeIds(Mat->GetExpressions(), Reachable));
        Out->SetArrayField(TEXT("comments"), SerializeComments(Mat->GetEditorComments()));
        Out->SetNumberField(TEXT("shading_model"), (int32)Mat->GetShadingModels().GetFirstShadingModel());
        TSharedPtr<FJsonObject> UsageFlags = MakeShared<FJsonObject>();
        for (const auto& Usage : HaybaMaterialUsageAliases())
            UsageFlags->SetBoolField(Usage.Key, Mat->GetUsageByFlag(Usage.Value));
        Out->SetObjectField(TEXT("usage_flags"), UsageFlags);
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
    FString NodeId, MatPath, FuncPath;
    FHaybaParamReader ParamR(P, TEXT("material_set_node"));
    NodeId = ParamR.RequiredString(TEXT("node_id"));
    MatPath = ParamR.OptionalString(TEXT("material_path"));
    FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const TSharedPtr<FJsonObject> PropsObj = ParamR.OptionalObject(TEXT("properties"), 128);
    bool bHasPos = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (!bHasPos && !PropsObj.IsValid())
        ParamR.AddError(TEXT("pass 'node_pos' and/or a non-empty 'properties' object; an empty update is not a mutation"));
    if (PropsObj.IsValid() && PropsObj->Values.Num() == 0)
        ParamR.AddError(TEXT("'properties' is empty"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    const int32 X = bHasPos ? static_cast<int32>(Pos[0]) : 0;
    const int32 Y = bHasPos ? static_cast<int32>(Pos[1]) : 0;

    FApplyNodePropsResult PR;
    auto ApplyTo = [&](UMaterialExpression* Expr) {
        if (bHasPos) { Expr->MaterialExpressionEditorX = X; Expr->MaterialExpressionEditorY = Y; }
        if (PropsObj.IsValid()) PR = ApplyNodeProps(Expr, PropsObj);
    };

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_set_node: function not found"));
        UMaterialExpression* Expr = FindExprByNameInFunction(Fn, NodeId);
        if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_node: node not found: %s"), *NodeId));
        TArray<FString> Problems;
        if (!PreflightNodeProps(Expr->GetClass(), PropsObj, Problems))
            return FHaybaHandlerResult::Err(FString::Printf(
                TEXT("material_set_node: property preflight failed: %s. Node position, properties, and dirty state were not changed."),
                *FString::Join(Problems, TEXT("; "))));
        Fn->Modify();
        Expr->Modify();
        ApplyTo(Expr);
        // Staged only; compile explicitly after the function graph is complete.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), NodeId);
        Out->SetBoolField(TEXT("verified"), (!bHasPos
            || (Expr->MaterialExpressionEditorX == X && Expr->MaterialExpressionEditorY == Y))
            && PR.Unknown.Num() == 0);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_set_node"));
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_node: node not found: %s"), *NodeId));
    TArray<FString> Problems;
    if (!PreflightNodeProps(Expr->GetClass(), PropsObj, Problems))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_set_node: property preflight failed: %s. Node position, properties, and dirty state were not changed."),
            *FString::Join(Problems, TEXT("; "))));
    Mat->Modify();
    Expr->Modify();
    ApplyTo(Expr);
    // Deferred compile: keep the staged graph dirty in memory until the guarded
    // material_compile boundary validates and saves it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), NodeId);
    Out->SetBoolField(TEXT("verified"), (!bHasPos
        || (Expr->MaterialExpressionEditorX == X && Expr->MaterialExpressionEditorY == Y))
        && PR.Unknown.Num() == 0);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    AttachNodePropsResult(Out.ToSharedRef(), PR, Expr, TEXT("material_set_node"));
    return FHaybaHandlerResult::Ok(Out);
}

// Delete an existing node by id, in a material or function.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDeleteNode(const TSharedPtr<FJsonObject>& P)
{
    FString NodeId, FuncPath, MatPath;
    FHaybaParamReader ParamR(P, TEXT("material_delete_node"));
    NodeId = ParamR.RequiredString(TEXT("node_id"));
    FuncPath = ParamR.OptionalString(TEXT("function_path"));
    MatPath = ParamR.OptionalString(TEXT("material_path"));
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_delete_node: function not found"));
        UMaterialExpression* Expr = FindExprByNameInFunction(Fn, NodeId);
        if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
        Fn->Modify();
        UMaterialEditingLibrary::DeleteMaterialExpressionInFunction(Fn, Expr);
        // Staged only; compile explicitly after the function graph is complete.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("deleted"), true);
        Out->SetBoolField(TEXT("verified"), FindExprByNameInFunction(Fn, NodeId) == nullptr);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_delete_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
    Mat->Modify();
    UMaterialEditingLibrary::DeleteMaterialExpression(Mat, Expr);
    // Deferred compile: keep the staged graph dirty in memory until the guarded
    // material_compile boundary validates and saves it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("deleted"), true);
    Out->SetBoolField(TEXT("verified"), FindExprByName(Mat, NodeId) == nullptr);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

// Add a titled comment BOX (not a graph node). Comment boxes live in the
// expression collection's EditorComments array, separate from Expressions —
// CreateMaterialExpression would otherwise drop a stray empty node.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddComment(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_add_comment"));
    const FString Text = ParamR.OptionalString(TEXT("text"), FString(), 4096);
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    bool bHasPos = false, bHasSize = false, bHasColor = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    const TArray<double> Size = ReadFiniteNumberArray(ParamR, TEXT("size"), 2, 2, bHasSize);
    const TArray<double> ColorValues = ReadFiniteNumberArray(ParamR, TEXT("color"), 3, 4, bHasColor);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    ValidateIntegerArrayRange(ParamR, TEXT("size"), Size, bHasSize, 1, 1000000);
    ValidateNumberArrayRange(ParamR, TEXT("color"), ColorValues, bHasColor, 0.0, 1.0);
    const int32 Font = ParamR.OptionalIntInRange(TEXT("font_size"), 18, 1, 512);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    const int32 X = bHasPos ? static_cast<int32>(Pos[0]) : 0;
    const int32 Y = bHasPos ? static_cast<int32>(Pos[1]) : 0;
    const int32 W = bHasSize ? static_cast<int32>(Size[0]) : 400;
    const int32 H = bHasSize ? static_cast<int32>(Size[1]) : 200;
    const FLinearColor Color = bHasColor
        ? FLinearColor(ColorValues[0], ColorValues[1], ColorValues[2],
            ColorValues.Num() >= 4 ? ColorValues[3] : 1.0)
        : FLinearColor::White;

    auto Setup = [&](UMaterialExpressionComment* C) {
        C->Text = Text; C->SizeX = W; C->SizeY = H; C->CommentColor = Color; C->FontSize = Font;
        C->MaterialExpressionEditorX = X; C->MaterialExpressionEditorY = Y;
    };

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_comment: function not found"));
        Fn->Modify();
        UMaterialExpressionComment* C = NewObject<UMaterialExpressionComment>(Fn);
        Setup(C);
        Fn->GetExpressionCollection().AddComment(C);
        // Comments do not justify a crash-prone function compile/broadcast.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("comment_id"), C->GetName());
        Out->SetBoolField(TEXT("verified"), Fn->GetEditorComments().Contains(C));
        Out->SetBoolField(TEXT("save_requested"), false);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_comment: material not found"));
    Mat->Modify();
    UMaterialExpressionComment* C = NewObject<UMaterialExpressionComment>(Mat);
    Setup(C);
    Mat->GetExpressionCollection().AddComment(C);
    // Comments do not justify an eager PostEditChange/save either: keep one
    // explicit persistence boundary for the entire graph edit session.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("comment_id"), C->GetName());
    Out->SetBoolField(TEXT("verified"), Mat->GetEditorComments().Contains(C));
    Out->SetBoolField(TEXT("save_requested"), false);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

// Delete a comment BOX by id. Comments live in the expression collection's
// EditorComments array (not Expressions), so material_delete_node can't reach
// them — this is the dedicated remover. (Named-reroute declaration/usage nodes
// ARE expressions, so material_delete_node already deletes those.)
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDeleteComment(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_delete_comment"));
    const FString CommentId = ParamR.RequiredString(TEXT("comment_id"));
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_delete_comment: function not found"));
        for (const TObjectPtr<UMaterialExpressionComment>& C : Fn->GetEditorComments())
        {
            if (C && C->GetName() == CommentId)
            {
                Fn->Modify();
                Fn->GetExpressionCollection().RemoveComment(C);
                Fn->MarkPackageDirty();
                TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
                Out->SetBoolField(TEXT("deleted"), true);
                Out->SetBoolField(TEXT("verified"), !Fn->GetEditorComments().Contains(C));
                Out->SetBoolField(TEXT("save_requested"), false);
                Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
                return FHaybaHandlerResult::Ok(Out);
            }
        }
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_comment: comment not found: %s"), *CommentId));
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_delete_comment: material not found"));
    for (const TObjectPtr<UMaterialExpressionComment>& C : Mat->GetEditorComments())
    {
        if (C && C->GetName() == CommentId)
        {
            Mat->Modify();
            Mat->GetExpressionCollection().RemoveComment(C);
            Mat->MarkPackageDirty();  // comments don't affect compilation; in-memory per the deferred-compile model
            TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
            Out->SetBoolField(TEXT("deleted"), true);
            Out->SetBoolField(TEXT("verified"), !Mat->GetEditorComments().Contains(C));
            Out->SetBoolField(TEXT("save_requested"), false);
            Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
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
    FHaybaParamReader ParamR(P, TEXT("material_set_comment"));
    const FString CommentId = ParamR.RequiredString(TEXT("comment_id"));
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    const bool bHasText = ParamR.Raw().IsValid() && ParamR.Raw()->HasField(TEXT("text"));
    const FString Text = ParamR.OptionalString(TEXT("text"), FString(), 4096);
    bool bHasPos = false, bHasSize = false, bHasColor = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    const TArray<double> Size = ReadFiniteNumberArray(ParamR, TEXT("size"), 2, 2, bHasSize);
    const TArray<double> ColorValues = ReadFiniteNumberArray(ParamR, TEXT("color"), 3, 4, bHasColor);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    ValidateIntegerArrayRange(ParamR, TEXT("size"), Size, bHasSize, 1, 1000000);
    ValidateNumberArrayRange(ParamR, TEXT("color"), ColorValues, bHasColor, 0.0, 1.0);
    const bool bHasFont = ParamR.Raw().IsValid() && ParamR.Raw()->HasField(TEXT("font_size"));
    const int32 Font = ParamR.OptionalIntInRange(TEXT("font_size"), 18, 1, 512);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (!bHasText && !bHasPos && !bHasSize && !bHasColor && !bHasFont)
        ParamR.AddError(TEXT("no comment fields to update"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // Apply only the provided fields to a found comment.
    auto Apply = [&](UMaterialExpressionComment* C)
    {
        C->Modify();
        if (bHasText) C->Text = Text;
        if (bHasPos)
        { C->MaterialExpressionEditorX = static_cast<int32>(Pos[0]); C->MaterialExpressionEditorY = static_cast<int32>(Pos[1]); }
        if (bHasSize)
        { C->SizeX = static_cast<int32>(Size[0]); C->SizeY = static_cast<int32>(Size[1]); }
        if (bHasColor)
            C->CommentColor = FLinearColor(ColorValues[0], ColorValues[1], ColorValues[2], ColorValues.Num() >= 4 ? ColorValues[3] : 1.0);
        if (bHasFont) C->FontSize = Font;
    };
    auto Verify = [&](const UMaterialExpressionComment* C)
    {
        if (!C) return false;
        if (bHasText && C->Text != Text) return false;
        if (bHasPos && (C->MaterialExpressionEditorX != static_cast<int32>(Pos[0])
            || C->MaterialExpressionEditorY != static_cast<int32>(Pos[1]))) return false;
        if (bHasSize && (C->SizeX != static_cast<int32>(Size[0])
            || C->SizeY != static_cast<int32>(Size[1]))) return false;
        if (bHasColor)
        {
            const FLinearColor Expected(
                ColorValues[0], ColorValues[1], ColorValues[2],
                ColorValues.Num() >= 4 ? ColorValues[3] : 1.0);
            if (!C->CommentColor.Equals(Expected)) return false;
        }
        return !bHasFont || C->FontSize == Font;
    };

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_set_comment: function not found"));
        for (const TObjectPtr<UMaterialExpressionComment>& C : Fn->GetEditorComments())
        {
            if (C && C->GetName() == CommentId)
            {
                Apply(C);
                Fn->MarkPackageDirty();
                TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
                Out->SetStringField(TEXT("comment_id"), CommentId);
                Out->SetBoolField(TEXT("verified"), Verify(C));
                Out->SetBoolField(TEXT("save_requested"), false);
                Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
                return FHaybaHandlerResult::Ok(Out);
            }
        }
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_comment: comment not found: %s"), *CommentId));
    }

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
            Out->SetBoolField(TEXT("verified"), Verify(C));
            Out->SetBoolField(TEXT("save_requested"), false);
            Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
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
    FHaybaParamReader ParamR(P, TEXT("material_add_reroute_declaration"));
    const FString Name = ParamR.RequiredString(TEXT("name"), 256);
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    bool bHasPos = false, bHasColor = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    const TArray<double> ColorValues = ReadFiniteNumberArray(ParamR, TEXT("color"), 3, 4, bHasColor);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    ValidateNumberArrayRange(ParamR, TEXT("color"), ColorValues, bHasColor, 0.0, 1.0);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    int32 X = bHasPos ? static_cast<int32>(Pos[0]) : 0;
    int32 Y = bHasPos ? static_cast<int32>(Pos[1]) : 0;
    const FLinearColor Color = bHasColor
        ? FLinearColor(ColorValues[0], ColorValues[1], ColorValues[2], ColorValues.Num() >= 4 ? ColorValues[3] : 1.0)
        : FLinearColor::White;

    UClass* Cls = UMaterialExpressionNamedRerouteDeclaration::StaticClass();
    auto Setup = [&](UMaterialExpressionNamedRerouteDeclaration* D) {
        D->Name = FName(*Name);
        if (bHasColor) D->NodeColor = Color;
        // VariableGuid is auto-generated in PostInitProperties (private
        // UpdateVariableGuid); guard in case it's empty so usages can bind.
        if (!D->VariableGuid.IsValid()) D->VariableGuid = FGuid::NewGuid();
    };

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: function not found"));
        for (UMaterialExpression* Existing : Fn->GetExpressions())
            if (const UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(Existing);
                D && D->Name.ToString().Equals(Name, ESearchCase::IgnoreCase))
                return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_declaration: name '%s' already exists; nothing was changed"), *Name));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        Fn->Modify();
        UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, Cls, X, Y));
        if (!D) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: create failed"));
        Setup(D);
        // Staged only; material_compile(function_path) is the guarded boundary.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), D->GetName());
        Out->SetBoolField(TEXT("verified"), FindExprByNameInFunction(Fn, D->GetName()) == D
            && D->Name == FName(*Name) && D->VariableGuid.IsValid());
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: material not found"));
    for (UMaterialExpression* Existing : Mat->GetExpressions())
        if (const UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(Existing);
            D && D->Name.ToString().Equals(Name, ESearchCase::IgnoreCase))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_declaration: name '%s' already exists; nothing was changed"), *Name));
    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    Mat->Modify();
    UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(UMaterialEditingLibrary::CreateMaterialExpression(Mat, Cls, X, Y));
    if (!D) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: create failed"));
    Setup(D);
    // Deferred compile: keep the staged graph dirty in memory until the guarded
    // material_compile boundary validates and saves it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), D->GetName());
    Out->SetBoolField(TEXT("verified"), FindExprByName(Mat, D->GetName()) == D
        && D->Name == FName(*Name) && D->VariableGuid.IsValid());
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

// Create a Named-Reroute USAGE node bound to an existing declaration by object
// pointer + GUID (not a wire — material_connect_nodes can't express this). Its
// output is wired to targets with material_connect_nodes (from_node = <this id>).
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddRerouteUsage(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_add_reroute_usage"));
    const FString DeclId = ParamR.RequiredString(TEXT("declaration_id"));
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    bool bHasPos = false;
    const TArray<double> Pos = ReadFiniteNumberArray(ParamR, TEXT("node_pos"), 2, 2, bHasPos);
    ValidateIntegerArrayRange(ParamR, TEXT("node_pos"), Pos, bHasPos, -10000000, 10000000);
    if (MatPath.IsEmpty() == FuncPath.IsEmpty())
        ParamR.AddError(TEXT("pass exactly one of 'material_path' or 'function_path'"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    int32 X = bHasPos ? static_cast<int32>(Pos[0]) : 0;
    int32 Y = bHasPos ? static_cast<int32>(Pos[1]) : 0;

    UClass* Cls = UMaterialExpressionNamedRerouteUsage::StaticClass();

    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: function not found"));
        UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(FindExprByNameInFunction(Fn, DeclId));
        if (!D) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_usage: declaration not found: %s"), *DeclId));
        if (!bHasPos) HaybaAutoNodePos(Fn->GetExpressions().Num(), X, Y);
        Fn->Modify();
        UMaterialExpressionNamedRerouteUsage* U = Cast<UMaterialExpressionNamedRerouteUsage>(UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, Cls, X, Y));
        if (!U) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: create failed"));
        U->Declaration = D;
        U->DeclarationGuid = D->VariableGuid;
        // Staged only; material_compile(function_path) is the guarded boundary.
        Fn->MarkPackageDirty();  // in-memory only — function written to disk by material_compile(function_path); avoids a half-built function landing on disk and asserting when the editor opens/compiles it
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), U->GetName());
        Out->SetBoolField(TEXT("verified"), FindExprByNameInFunction(Fn, U->GetName()) == U
            && U->Declaration == D && U->DeclarationGuid == D->VariableGuid);
        Out->SetBoolField(TEXT("dirty"), Fn->GetOutermost()->IsDirty());
        return FHaybaHandlerResult::Ok(Out);
    }

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: material not found"));
    UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(FindExprByName(Mat, DeclId));
    if (!D) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_reroute_usage: declaration not found: %s"), *DeclId));
    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    Mat->Modify();
    UMaterialExpressionNamedRerouteUsage* U = Cast<UMaterialExpressionNamedRerouteUsage>(UMaterialEditingLibrary::CreateMaterialExpression(Mat, Cls, X, Y));
    if (!U) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: create failed"));
    U->Declaration = D;
    U->DeclarationGuid = D->VariableGuid;
    // Deferred compile: keep the staged graph dirty in memory until the guarded
    // material_compile boundary validates and saves it.
    Mat->MarkPackageDirty();  // in-memory only — master materials are written to disk ONLY by material_compile, so a half-built invalid-Normal graph never lands on disk for the editor to thumbnail/open-compile (Substrate check(NormalCodeChunk!=INDEX_NONE) crash)
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), U->GetName());
    Out->SetBoolField(TEXT("verified"), FindExprByName(Mat, U->GetName()) == U
        && U->Declaration == D && U->DeclarationGuid == D->VariableGuid);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}

static const TMap<FString, EMaterialUsage>& HaybaMaterialUsageAliases()
{
    static const TMap<FString, EMaterialUsage> Aliases = {
        { TEXT("used_with_skeletal_meshes"), MATUSAGE_SkeletalMesh },
        { TEXT("used_with_particle_sprites"), MATUSAGE_ParticleSprites },
        { TEXT("used_with_beam_trails"), MATUSAGE_BeamTrails },
        { TEXT("used_with_mesh_particles"), MATUSAGE_MeshParticles },
        { TEXT("used_with_static_lighting"), MATUSAGE_StaticLighting },
        { TEXT("used_with_morph_targets"), MATUSAGE_MorphTargets },
        { TEXT("used_with_spline_meshes"), MATUSAGE_SplineMesh },
        { TEXT("used_with_instanced_static_meshes"), MATUSAGE_InstancedStaticMeshes },
        { TEXT("used_with_geometry_collections"), MATUSAGE_GeometryCollections },
        { TEXT("used_with_clothing"), MATUSAGE_Clothing },
        { TEXT("used_with_niagara_sprites"), MATUSAGE_NiagaraSprites },
        { TEXT("used_with_niagara_ribbons"), MATUSAGE_NiagaraRibbons },
        { TEXT("used_with_niagara_mesh_particles"), MATUSAGE_NiagaraMeshParticles },
        { TEXT("used_with_geometry_cache"), MATUSAGE_GeometryCache },
        { TEXT("used_with_water"), MATUSAGE_Water },
        { TEXT("used_with_hair_strands"), MATUSAGE_HairStrands },
        { TEXT("used_with_lidar_point_cloud"), MATUSAGE_LidarPointCloud },
        { TEXT("used_with_nanite"), MATUSAGE_Nanite },
        { TEXT("used_with_voxels"), MATUSAGE_Voxels },
        { TEXT("used_with_volumetric_cloud"), MATUSAGE_VolumetricCloud },
        { TEXT("used_with_heterogeneous_volumes"), MATUSAGE_HeterogeneousVolumes },
        { TEXT("used_with_static_mesh"), MATUSAGE_StaticMesh },
        { TEXT("used_with_editor_compositing"), MATUSAGE_EditorCompositing },
        { TEXT("used_with_neural_networks"), MATUSAGE_NeuralNetworks },
        { TEXT("used_with_mesh_deformer"), MATUSAGE_MeshDeformer },
        { TEXT("used_with_instanced_skinned_meshes"), MATUSAGE_InstancedSkinnedMesh },
        { TEXT("used_with_curves"), MATUSAGE_Curves },
    };
    return Aliases;
}

static const TMap<FString, FString>& HaybaMaterialUsageCompatibilityAliases()
{
    // material_set_property historically advertised raw UMaterial UPROPERTY
    // names. Keep the production-critical spline spelling compatible, but
    // canonicalize it before touching UE's deprecated bitfield surface.
    static const TMap<FString, FString> Aliases = {
        { TEXT("bUsedWithSplineMeshes"), TEXT("used_with_spline_meshes") },
    };
    return Aliases;
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetProperty(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_set_property"));
    const FString MatPath = ParamR.RequiredString(TEXT("material_path"));
    const TSharedPtr<FJsonObject> PropsObj = ParamR.OptionalObject(TEXT("properties"), 128);
    if (!PropsObj.IsValid() || PropsObj->Values.Num() == 0)
        ParamR.AddError(TEXT("'properties' must be a non-empty object"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_property: material not found"));

    // Friendly alias -> real UMaterial UPROPERTY name.
    static const TMap<FString, FString> Aliases = {
        { TEXT("domain"),                  TEXT("MaterialDomain") },
        { TEXT("blend_mode"),              TEXT("BlendMode") },
        { TEXT("shading_model"),           TEXT("ShadingModel") },
        { TEXT("two_sided"),               TEXT("TwoSided") },
        { TEXT("opacity_mask_clip_value"), TEXT("OpacityMaskClipValue") },
        { TEXT("enable_tessellation"),     TEXT("bEnableTessellation") },  // required for the displacement output to tessellate (Nanite)
    };

    // Stage only the requested UPROPERTY values on a fresh transient material.
    // Duplicating the live UMaterial would also duplicate its entire expression
    // graph/resource state, needlessly walking the very crash-prone graph this
    // setter is trying not to compile.
    UMaterial* StagedMat = NewObject<UMaterial>(GetTransientPackage());
    if (!StagedMat)
        return FHaybaHandlerResult::Err(TEXT("material_set_property: could not allocate a staging material; nothing was changed"));

    // Usage aliases are deliberately allowlisted and typed. These flags select
    // vertex-factory shader permutations; treating them as arbitrary reflection
    // keys silently failed on UE5.8 and made spline meshes substitute the pale
    // default material in game.
    const TMap<FString, EMaterialUsage>& UsageAliases = HaybaMaterialUsageAliases();

    struct FUsageRequest
    {
        FString Key;
        EMaterialUsage Usage = MATUSAGE_MAX;
        bool bRequested = false;
        bool bPrevious = false;
    };
    TArray<FUsageRequest> RequestedUsage;
    TSet<FString> RequestedUsageKeys;
    bool bHasOrdinarySetting = false;
    TArray<FString> Problems;
    for (const auto& Pair : PropsObj->Values)
    {
        const FString InputKey(*Pair.Key);
        const FString* CompatibilityKey = HaybaMaterialUsageCompatibilityAliases().Find(InputKey);
        const FString Key = CompatibilityKey ? *CompatibilityKey : InputKey;
        if (const EMaterialUsage* Usage = UsageAliases.Find(Key))
        {
            if (!Pair.Value.IsValid() || Pair.Value->Type != EJson::Boolean)
            {
                Problems.Add(FString::Printf(TEXT("properties.%s must be a JSON boolean"), *InputKey));
                continue;
            }
            if (RequestedUsageKeys.Contains(Key))
            {
                Problems.Add(FString::Printf(TEXT("properties.%s duplicates usage flag '%s'"), *InputKey, *Key));
                continue;
            }
            RequestedUsageKeys.Add(Key);
            RequestedUsage.Add({ Key, *Usage, Pair.Value->AsBool(), Mat->GetUsageByFlag(*Usage) });
        }
        else if (InputKey.StartsWith(TEXT("used_with_"), ESearchCase::IgnoreCase) ||
                 InputKey.StartsWith(TEXT("bUsedWith"), ESearchCase::IgnoreCase))
        {
            TArray<FString> Supported;
            UsageAliases.GetKeys(Supported);
            Supported.Sort();
            Problems.Add(FString::Printf(
                TEXT("properties.%s is an unsupported usage flag; supported keys: %s"),
                *InputKey, *FString::Join(Supported, TEXT(", "))));
        }
        else if (const FString* RealName = Aliases.Find(Key))
        {
            bHasOrdinarySetting = true;
            FProperty* Prop = Mat->GetClass()->FindPropertyByName(FName(**RealName));
            FString Reason;
            if (!Prop || !Prop->HasAnyPropertyFlags(CPF_Edit)
                || Prop->HasAnyPropertyFlags(CPF_EditConst | CPF_Transient | CPF_Deprecated)
                || !ValidateJsonForProperty(Prop, Pair.Value, Reason))
            {
                if (!Prop) Reason = TEXT("is not a mutable material property");
                Problems.Add(FString::Printf(TEXT("properties.%s %s"), *InputKey, *Reason));
                continue;
            }

            const EJson ExpectedType =
                (Key == TEXT("two_sided") || Key == TEXT("enable_tessellation")) ? EJson::Boolean :
                (Key == TEXT("opacity_mask_clip_value")) ? EJson::Number : EJson::String;
            if (!Pair.Value.IsValid() || Pair.Value->Type != ExpectedType)
            {
                Problems.Add(FString::Printf(TEXT("properties.%s has the wrong JSON type"), *InputKey));
                continue;
            }

            if (Key == TEXT("opacity_mask_clip_value"))
            {
                const double Value = Pair.Value->AsNumber();
                if (!FMath::IsFinite(Value) || Value < 0.0 || Value > 1.0)
                {
                    Problems.Add(TEXT("properties.opacity_mask_clip_value must be finite and between 0 and 1"));
                    continue;
                }
            }
            else if (Key == TEXT("domain") && StaticEnum<EMaterialDomain>()->GetValueByNameString(Pair.Value->AsString()) == INDEX_NONE)
            {
                Problems.Add(TEXT("properties.domain is not a valid material-domain enum value"));
                continue;
            }
            else if (Key == TEXT("blend_mode") && StaticEnum<EBlendMode>()->GetValueByNameString(Pair.Value->AsString()) == INDEX_NONE)
            {
                Problems.Add(TEXT("properties.blend_mode is not a valid blend-mode enum value"));
                continue;
            }
            else if (Key == TEXT("shading_model") && StaticEnum<EMaterialShadingModel>()->GetValueByNameString(Pair.Value->AsString()) == INDEX_NONE)
            {
                Problems.Add(TEXT("properties.shading_model is not a valid shading-model enum value"));
                continue;
            }

            // Prove the exact reflection conversion against isolated storage.
            // The live material is untouched until every key has passed.
            Prop->CopyCompleteValue_InContainer(StagedMat, Mat);
            if (!HaybaReflection::SetProp(StagedMat, *RealName, Pair.Value))
            {
                Problems.Add(FString::Printf(TEXT("properties.%s failed while staging"), *InputKey));
                continue;
            }
            if (Key == TEXT("shading_model"))
            {
                const EMaterialShadingModel Value = static_cast<EMaterialShadingModel>(
                    StaticEnum<EMaterialShadingModel>()->GetValueByNameString(Pair.Value->AsString()));
                StagedMat->SetShadingModel(Value);
            }
        }
        else
        {
            Problems.Add(FString::Printf(
                TEXT("properties.%s is unsupported; use a documented friendly alias"), *InputKey));
        }
    }

    if (RequestedUsage.Num() > 0 && bHasOrdinarySetting)
        Problems.Add(TEXT("submit usage flags separately from other settings so usage changes remain atomic"));

    if (RequestedUsage.Num() > 0 &&
        Mat->MaterialDomain != MD_Surface && Mat->MaterialDomain != MD_DeferredDecal && Mat->MaterialDomain != MD_Volume)
    {
        Problems.Add(TEXT("usage flags require a Surface, Deferred Decal, or Volume material domain"));
    }

    if (Problems.Num() > 0)
    {
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_set_property: preflight failed: %s. The material and package dirty state were not changed."),
            *FString::Join(Problems, TEXT("; "))));
    }

    const bool bPackageWasDirty = Mat->GetOutermost()->IsDirty();
    TArray<TSharedPtr<FJsonValue>> Applied;
    TArray<TSharedPtr<FJsonValue>> Changed;
    if (RequestedUsage.Num() > 0)
    {
        bool bAnyChanged = false;
        for (const FUsageRequest& Request : RequestedUsage) bAnyChanged |= Request.bPrevious != Request.bRequested;
        if (bAnyChanged) Mat->Modify();

        for (const FUsageRequest& Request : RequestedUsage)
        {
            Applied.Add(MakeShared<FJsonValueString>(Request.Key));
            if (Request.bPrevious != Request.bRequested)
            {
                Mat->SetUsageByFlag(Request.Usage, Request.bRequested);
                Changed.Add(MakeShared<FJsonValueString>(Request.Key));
            }
        }
        bool bUsageVerified = true;
        TSharedPtr<FJsonObject> UsageReadback = MakeShared<FJsonObject>();
        for (const FUsageRequest& Request : RequestedUsage)
        {
            const bool bObserved = Mat->GetUsageByFlag(Request.Usage);
            UsageReadback->SetBoolField(Request.Key, bObserved);
            bUsageVerified &= bObserved == Request.bRequested;
        }
        const bool bDirtyMarked = !bAnyChanged || Mat->MarkPackageDirty();
        if (!bUsageVerified || !bDirtyMarked)
        {
            for (const FUsageRequest& Request : RequestedUsage)
                Mat->SetUsageByFlag(Request.Usage, Request.bPrevious);
            Mat->GetOutermost()->SetDirtyFlag(bPackageWasDirty);
            return FHaybaHandlerResult::Err(TEXT("material_set_property: usage readback or dirty-mark verification failed; verification_failed contains one or more usage flags; changes were rolled back"));
        }

        bool bAnyUsageFlagDirty = false;
        for (const auto& Usage : UsageAliases)
            bAnyUsageFlagDirty |= Mat->IsUsageFlagDirty(Usage.Value);
        const bool bPackageDirty = Mat->GetOutermost()->IsDirty();
        const bool bRequiresCompile = bPackageDirty || bAnyUsageFlagDirty;

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("material_path"), Mat->GetPathName());
        Out->SetArrayField(TEXT("applied"), Applied);
        Out->SetArrayField(TEXT("changed"), Changed);
        Out->SetArrayField(
            TEXT("verification_failed"),
            TArray<TSharedPtr<FJsonValue>>());
        Out->SetObjectField(TEXT("usage_flags"), UsageReadback);
        Out->SetBoolField(TEXT("usage_flags_verified"), true);
        Out->SetBoolField(TEXT("dirty"), bPackageDirty);
        Out->SetBoolField(TEXT("saved"), false);
        Out->SetBoolField(TEXT("requires_compile"), bRequiresCompile);
        Out->SetStringField(TEXT("note"), bAnyChanged
            ? TEXT("usage flags staged and verified; call material_compile to compile permutations and save")
            : bRequiresCompile
                ? TEXT("requested usage flags already matched, but staged material changes still require material_compile")
                : TEXT("requested usage flags already matched the clean saved material; no compile or save is required"));
        return FHaybaHandlerResult::Ok(Out);
    }

    struct FOrdinarySnapshot
    {
        EMaterialDomain Domain;
        EBlendMode BlendMode;
        EMaterialShadingModel ShadingModel;
        bool bTwoSided;
        float OpacityMaskClipValue;
        bool bEnableTessellation;
    } Before {
        Mat->MaterialDomain,
        Mat->BlendMode,
        Mat->GetShadingModels().GetFirstShadingModel(),
        Mat->TwoSided != 0,
        Mat->OpacityMaskClipValue,
        Mat->bEnableTessellation != 0,
    };

    auto RestoreOrdinary = [&]()
    {
        Mat->MaterialDomain = Before.Domain;
        Mat->BlendMode = Before.BlendMode;
        Mat->SetShadingModel(Before.ShadingModel);
        Mat->TwoSided = Before.bTwoSided;
        Mat->OpacityMaskClipValue = Before.OpacityMaskClipValue;
        Mat->bEnableTessellation = Before.bEnableTessellation;
    };

    bool bAnyChanged = false;
    for (const auto& Pair : PropsObj->Values)
    {
        const FString Key(*Pair.Key);
        Applied.Add(MakeShared<FJsonValueString>(Key));
        bool bKeyChanged = false;
        if (Key == TEXT("domain"))
            bKeyChanged = Before.Domain != StagedMat->MaterialDomain;
        else if (Key == TEXT("blend_mode"))
            bKeyChanged = Before.BlendMode != StagedMat->BlendMode;
        else if (Key == TEXT("shading_model"))
            bKeyChanged = Before.ShadingModel != StagedMat->GetShadingModels().GetFirstShadingModel();
        else if (Key == TEXT("two_sided")) bKeyChanged = Before.bTwoSided != (StagedMat->TwoSided != 0);
        else if (Key == TEXT("opacity_mask_clip_value")) bKeyChanged = !FMath::IsNearlyEqual(Before.OpacityMaskClipValue, StagedMat->OpacityMaskClipValue);
        else if (Key == TEXT("enable_tessellation")) bKeyChanged = Before.bEnableTessellation != (StagedMat->bEnableTessellation != 0);
        bAnyChanged |= bKeyChanged;
        if (bKeyChanged) Changed.Add(MakeShared<FJsonValueString>(Key));
    }
    if (bAnyChanged) Mat->Modify();

    TSharedPtr<FJsonObject> Readback = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> VerificationFailed;
    for (const auto& Pair : PropsObj->Values)
    {
        const FString Key(*Pair.Key);
        bool bKeyVerified = false;
        if (Key == TEXT("domain"))
        {
            const EMaterialDomain Value = StagedMat->MaterialDomain;
            Mat->MaterialDomain = Value;
            const FString Observed = StaticEnum<EMaterialDomain>()->GetNameStringByValue(Mat->MaterialDomain);
            Readback->SetStringField(Key, Observed);
            bKeyVerified = Mat->MaterialDomain == Value;
        }
        else if (Key == TEXT("blend_mode"))
        {
            const EBlendMode Value = StagedMat->BlendMode;
            Mat->BlendMode = Value;
            const FString Observed = StaticEnum<EBlendMode>()->GetNameStringByValue(Mat->BlendMode);
            Readback->SetStringField(Key, Observed);
            bKeyVerified = Mat->BlendMode == Value;
        }
        else if (Key == TEXT("shading_model"))
        {
            const EMaterialShadingModel Value = StagedMat->GetShadingModels().GetFirstShadingModel();
            Mat->SetShadingModel(Value);
            const EMaterialShadingModel ObservedValue = Mat->GetShadingModels().GetFirstShadingModel();
            Readback->SetStringField(Key, StaticEnum<EMaterialShadingModel>()->GetNameStringByValue(ObservedValue));
            bKeyVerified = ObservedValue == Value;
        }
        else if (Key == TEXT("two_sided"))
        {
            Mat->TwoSided = StagedMat->TwoSided;
            Readback->SetBoolField(Key, Mat->TwoSided != 0);
            bKeyVerified = (Mat->TwoSided != 0) == (StagedMat->TwoSided != 0);
        }
        else if (Key == TEXT("opacity_mask_clip_value"))
        {
            Mat->OpacityMaskClipValue = StagedMat->OpacityMaskClipValue;
            Readback->SetNumberField(Key, Mat->OpacityMaskClipValue);
            bKeyVerified = FMath::IsNearlyEqual(Mat->OpacityMaskClipValue, StagedMat->OpacityMaskClipValue);
        }
        else if (Key == TEXT("enable_tessellation"))
        {
            Mat->bEnableTessellation = StagedMat->bEnableTessellation;
            Readback->SetBoolField(Key, Mat->bEnableTessellation != 0);
            bKeyVerified = (Mat->bEnableTessellation != 0) == (StagedMat->bEnableTessellation != 0);
        }
        if (!bKeyVerified) VerificationFailed.Add(MakeShared<FJsonValueString>(Key));
    }
    const bool bDirtyMarked = !bAnyChanged || Mat->MarkPackageDirty();
    if (VerificationFailed.Num() > 0 || !bDirtyMarked)
    {
        RestoreOrdinary();
        Mat->GetOutermost()->SetDirtyFlag(bPackageWasDirty);
        TArray<FString> FailedNames;
        for (const TSharedPtr<FJsonValue>& Failed : VerificationFailed) FailedNames.Add(Failed->AsString());
        if (!bDirtyMarked) FailedNames.Add(TEXT("package_dirty_state"));
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("material_set_property: ordinary-setting readback or dirty-mark verification failed; verification_failed: %s; changes were rolled back"),
            *FString::Join(FailedNames, TEXT(", "))));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("material_path"), Mat->GetPathName());
    Out->SetArrayField(TEXT("applied"), Applied);
    Out->SetNumberField(TEXT("succeeded"), Applied.Num() - VerificationFailed.Num());
    Out->SetNumberField(TEXT("failed"), VerificationFailed.Num());
    Out->SetArrayField(TEXT("verification_failed"), VerificationFailed);
    Out->SetBoolField(TEXT("verified"), VerificationFailed.Num() == 0);
    Out->SetBoolField(TEXT("save_requested"), false);
    Out->SetArrayField(TEXT("changed"), Changed);
    Out->SetObjectField(TEXT("readback"), Readback);
    const bool bPackageDirty = Mat->GetOutermost()->IsDirty();
    Out->SetBoolField(TEXT("dirty"), bPackageDirty);
    Out->SetBoolField(TEXT("saved"), false);
    Out->SetBoolField(TEXT("requires_compile"), bPackageDirty);
    Out->SetStringField(TEXT("note"), TEXT("call material_compile to apply settings and write the material to disk"));
    return FHaybaHandlerResult::Ok(Out);
}

// Explicit, deferred compile. This is the ONE place the master-material graph
// is translated and saved (the per-edit handlers only stage dirty in-memory
// state). RecompileMaterial performs the editor change notifications and forces
// shader translation so compile errors surface. Validation catches known fatal
// graph shapes first, the remaining native broadcast is SEH-guarded, and only a
// clean return crosses the save boundary.
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
    {
        const EMaterialProperty Property = static_cast<EMaterialProperty>(Prop);
        if (!HaybaIsMaterialPropertyCompilerInputActive(Mat, Property)) continue;
        if (FExpressionInput* In = Mat->GetExpressionInputForProperty(Property))
            Out.Add(In);
    }
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
    FHaybaParamReader ParamR(P, TEXT("material_compile"));
    const FString FuncPath = ParamR.OptionalString(TEXT("function_path"));
    const FString MatPath = ParamR.OptionalString(TEXT("material_path"));
    if (FuncPath.IsEmpty() == MatPath.IsEmpty())
    {
        ParamR.AddError(TEXT("pass exactly one non-empty target: 'material_path' or 'function_path'"));
    }
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    // Material FUNCTIONS are no longer auto-saved per edit (a half-built function
    // on disk asserts when the editor opens/compiles it). This is their explicit
    // save point: refresh + write to disk.
    if (!FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_compile: function not found"));

        // Refuse to translate a crash-prone graph (uncatchable translator assert).
        TArray<FString> Problems;
        CollectMaterialGraphProblems(Fn->GetExpressions(), {}, Problems);
        if (Problems.Num() > 0)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("ok"), false);
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& Pr : Problems) Arr.Add(MakeShared<FJsonValueString>(Pr));
            Bad->SetArrayField(TEXT("errors"), Arr);
            Bad->SetStringField(TEXT("error"), TEXT("material_compile: graph preflight rejected the function; no compile or save was attempted."));
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
            Bad->SetBoolField(TEXT("ok"), false);
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            Bad->SetBoolField(TEXT("session_suspect"), true);
            Bad->SetStringField(TEXT("error"), TEXT("material_compile: native function compilation failed; the function was not saved. Restart the editor before another mutation."));
            Bad->SetStringField(TEXT("crash_guarded"), TEXT("material_compile(function): native access violation during UpdateMaterialFunction — commonly a stale Python-registered editor delegate firing on a GC'd target. Editor kept alive by the SEH guard; function NOT saved. Restart the editor before another mutation."));
            return FHaybaHandlerResult::Ok(Bad);
        }
        FString FnSaveErr;
        const bool bFnSaved = HaybaPersistAsset(Fn, FnSaveErr);
        TSharedPtr<FJsonObject> FnOut = MakeShared<FJsonObject>();
        FnOut->SetStringField(TEXT("function_path"), Fn->GetPathName());
        FnOut->SetBoolField(TEXT("ok"), bFnSaved);
        // UpdateMaterialFunction has no compiler-diagnostic return channel. We
        // can prove that the update call returned without a native fault, but
        // not that every dependent shader compiled cleanly.
        FnOut->SetBoolField(TEXT("update_completed"), true);
        FnOut->SetBoolField(TEXT("saved"), bFnSaved);
        if (!bFnSaved)
        {
            FnOut->SetStringField(TEXT("error"), TEXT("material_compile: function update completed, but persistence verification failed."));
            FnOut->SetStringField(TEXT("save_error"), FnSaveErr);
        }
        return FHaybaHandlerResult::Ok(FnOut);
    }

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
            Bad->SetBoolField(TEXT("ok"), false);
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            TArray<TSharedPtr<FJsonValue>> Arr;
            for (const FString& Pr : Problems) Arr.Add(MakeShared<FJsonValueString>(Pr));
            Bad->SetArrayField(TEXT("errors"), Arr);
            Bad->SetStringField(TEXT("error"), TEXT("material_compile: graph preflight rejected the material; no compile or save was attempted."));
            Bad->SetStringField(TEXT("blocked"), TEXT("graph would crash the HLSL translator; not compiled. Fix the listed problems (or run material_validate) then retry."));
            return FHaybaHandlerResult::Ok(Bad);
        }
    }

    TSharedPtr<FJsonObject> Out;
    // PostEditChange + RecompileMaterial broadcast editor change notifications
    // (FCoreUObjectDelegates, MaterialEditor). If a Python script registered a
    // delegate whose target was since garbage-collected/destroyed, that broadcast
    // dereferences freed memory — a native access violation that would kill the
    // editor (not a catchable C++/Python exception). Guard it.
    {
        bool bCompileCrashed = false;
        TArray<FString> CompileErrors;
        struct FCompileContext
        {
            UMaterial* Material = nullptr;
            TArray<FString>* Errors = nullptr;
        } Context{ Mat, &CompileErrors };
        HaybaSeh::RunGuarded(+[](void* P)
        {
            FCompileContext* C = static_cast<FCompileContext*>(P);
            // UE5.8 RecompileMaterial already performs the required
            // PreEditChange/PostEditChange pair. Calling PostEditChange here as
            // well double-broadcasts and can re-enter material delegates.
            *C->Errors = UMaterialEditingLibrary::RecompileMaterial(C->Material);
        }, &Context, bCompileCrashed);
        if (bCompileCrashed)
        {
            TSharedPtr<FJsonObject> Bad = MakeShared<FJsonObject>();
            Bad->SetBoolField(TEXT("ok"), false);
            Bad->SetBoolField(TEXT("saved"), false);
            Bad->SetBoolField(TEXT("has_errors"), true);
            Bad->SetBoolField(TEXT("compiled_clean"), false);
            Bad->SetBoolField(TEXT("session_suspect"), true);
            Bad->SetStringField(TEXT("error"), TEXT("material_compile: native material compilation failed; the material was not saved. Restart the editor before another mutation."));
            Bad->SetStringField(TEXT("crash_guarded"), TEXT("material_compile: native access violation during recompile/PostEditChange — commonly a stale Python-registered editor delegate firing on a garbage-collected target, or a re-entrant property broadcast. The editor was kept alive by the SEH guard and the material was NOT saved. Restart the editor before another mutation. Do not register UE editor delegates from python_run whose targets can be GC'd."));
            return FHaybaHandlerResult::Ok(Bad);
        }

        TArray<TSharedPtr<FJsonValue>> Errs;
        for (const FString& Error : CompileErrors) Errs.Add(MakeShared<FJsonValueString>(Error));

        const bool bCompiledClean = CompileErrors.Num() == 0;
        FString SaveErr;
        bool bSaved = false;
        if (bCompiledClean)
        {
            // A failed compile must remain an in-memory diagnostic. Persisting
            // it made a broken material survive restart and turned a truthful
            // compile failure into a destructive save.
            bSaved = HaybaPersistAsset(Mat, SaveErr);
        }

        Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("material_path"), Mat->GetPathName());
        Out->SetArrayField(TEXT("errors"), Errs);
        Out->SetBoolField(TEXT("ok"), bCompiledClean && bSaved);
        Out->SetBoolField(TEXT("compiled_clean"), bCompiledClean);
        Out->SetBoolField(TEXT("has_errors"), !bCompiledClean);
        Out->SetBoolField(TEXT("saved"), bSaved);
        if (!bCompiledClean)
        {
            Out->SetStringField(TEXT("error"), TEXT("material_compile: shader compilation failed; the material was not saved. Fix data.errors, then retry."));
        }
        else if (!bSaved)
        {
            Out->SetStringField(TEXT("error"), TEXT("material_compile: compilation succeeded, but persistence verification failed."));
            Out->SetStringField(TEXT("save_error"), SaveErr);
        }

        // Continue below to append optimization feedback using the recompiled
        // resource without compiling or saving a second time.
    }
    // Do not inspect a resource derived from a failed compile. Apart from being
    // misleading optimization feedback, downstream resource access adds risk
    // precisely when the translator has already said its state is invalid.
    FMaterialResource* Res = Out->GetBoolField(TEXT("compiled_clean"))
        ? Mat->GetMaterialResource(GMaxRHIShaderPlatform)
        : nullptr;

    // ── Optimization feedback ────────────────────────────────────────────────
    // After a clean recompile, read shader cost off the recompiled
    // FMaterialResource — the same numbers the Material Editor Stats panel shows
    // — so the AI building this material via MCP gets instruction counts,
    // texture samples, samplers, and interpolator usage as actionable feedback.
    if (Res && !Out->GetBoolField(TEXT("has_errors")))
    {
        TSharedPtr<FJsonObject> Stats = MakeShared<FJsonObject>();

        // Instruction counts per representative shader permutation.
        // ExtractMatertialStatsInfo is MATERIALEDITOR_API-exported; it internally
        // calls GetRepresentativeInstructionCounts (which is not exported).
        // Keep the extraction target off the C++ stack. If the guarded engine
        // call faults midway through mutating its TMaps, running that partially
        // written object's destructor outside SEH is another possible fault.
        // Quarantine the single allocation on the crash path; mandatory editor
        // restart will reclaim it. The normal path deletes it below.
        FShaderStatsInfo* Info = new FShaderStatsInfo();
        // Also MaterialEditor — guard it. A native fault means the resource is
        // no longer safe to inspect: continuing into the getters below could
        // immediately repeat the same AV outside SEH. Preserve the already
        // completed compile/save facts, but fail the logical operation and tell
        // the command boundary that this editor session is suspect.
        bool bStatsCrashed = false;
        {
            struct FStatsCtx { FShaderStatsInfo* I; FMaterialResource* R; } Ctx{ Info, Res };
            HaybaSeh::RunGuarded(+[](void* P)
            {
                FStatsCtx* C = static_cast<FStatsCtx*>(P);
                FMaterialStatsUtils::ExtractMatertialStatsInfo(GMaxRHIShaderPlatform, *C->I, C->R);
            }, &Ctx, bStatsCrashed);
        }
        if (bStatsCrashed)
        {
            Out->SetBoolField(TEXT("ok"), false);
            Out->SetBoolField(TEXT("session_suspect"), true);
            Out->SetStringField(TEXT("error"), TEXT(
                "material_compile: native access violation while reading optimization statistics after compile/save. "
                "No further FMaterialResource access was attempted; restart the editor before another mutation."));
            Out->SetStringField(TEXT("crash_guarded"), TEXT(
                "material_compile(stats): ExtractMatertialStatsInfo faulted under SEH after the material compile/save lifecycle completed."));
            return FHaybaHandlerResult::Ok(Out);
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
        for (const TPair<ERepresentativeShader, FShaderStatsInfo::FContent>& Pair : Info->ShaderInstructionCount)
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
        delete Info;
    }

    return FHaybaHandlerResult::Ok(Out);
}

// Task 4: material_disconnect — clear an input connection on a node or a
// material-output property connection. Mirrors material_connect_nodes in
// param shape; requires either to_node (+ optional to_input/to_input_index)
// or to_property.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDisconnect(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader ParamR(P, TEXT("material_disconnect"));
    const FString MatPath = ParamR.RequiredString(TEXT("material_path"));
    const FString ToNode = ParamR.OptionalString(TEXT("to_node"));
    const FString ToInput = ParamR.OptionalString(TEXT("to_input"));
    const FString PropStr = ParamR.OptionalString(TEXT("to_property"));
    const bool bHasIndex = ParamR.Raw().IsValid()
        && ParamR.Raw()->HasField(TEXT("to_input_index"));
    const int32 RequestedIndex = ParamR.OptionalIntInRange(TEXT("to_input_index"), 0, 0, 1023);
    const bool bHasNode = !ToNode.IsEmpty();
    const bool bHasProp = !PropStr.IsEmpty();
    if (bHasNode == bHasProp)
        ParamR.AddError(TEXT("pass exactly one target: 'to_node' or 'to_property'"));
    if (bHasIndex && !ToInput.IsEmpty())
        ParamR.AddError(TEXT("'to_input' and 'to_input_index' are mutually exclusive"));
    if (ParamR.HasErrors()) return FHaybaHandlerResult::Err(ParamR.ErrorMessage());

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_disconnect: material not found"));

    FExpressionInput* TargetInput = nullptr;
    if (bHasProp)
    {
        // Disconnect a material-output property (e.g. base_color, normal, etc.)
        EMaterialProperty Prop;
        if (!TryParseProperty(PropStr, Prop))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: unknown to_property: %s"), *PropStr));
        TargetInput = Mat->GetExpressionInputForProperty(Prop);
        if (!TargetInput)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: property has no ExpressionInput: %s"), *PropStr));
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
        else if (bHasIndex)
        {
            NamedIdx = RequestedIndex;
        }
        else
        {
            NamedIdx = 0; // default: first input
        }

        // Resolve completely before crossing the mutation boundary.
        int32 Cur = 0;
        for (FExpressionInputIterator It{ToExpr}; It; ++It)
        {
            if (Cur == NamedIdx)
            {
                TargetInput = It.Input;
                break;
            }
            ++Cur;
        }
        if (!TargetInput)
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_disconnect: input index %d out of range on %s"), NamedIdx, *ToNode));
    }

    const bool bAlreadyDisconnected = TargetInput->Expression == nullptr;
    if (!bAlreadyDisconnected)
    {
        Mat->Modify();
        TargetInput->Expression = nullptr;
        TargetInput->OutputIndex = 0;
        Mat->MarkPackageDirty();
    }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("disconnected"), !bAlreadyDisconnected);
    Out->SetBoolField(TEXT("already_disconnected"), bAlreadyDisconnected);
    Out->SetBoolField(TEXT("verified"), TargetInput->Expression == nullptr);
    Out->SetBoolField(TEXT("dirty"), Mat->GetOutermost()->IsDirty());
    return FHaybaHandlerResult::Ok(Out);
}
