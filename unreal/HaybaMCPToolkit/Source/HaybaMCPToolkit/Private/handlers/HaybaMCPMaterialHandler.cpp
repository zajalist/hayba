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
#include "MaterialShared.h"  // FMaterialResource, GetCompileErrors (material_compile)
#include "UObject/SavePackage.h"

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
        TEXT("material_add_reroute_declaration"),
        TEXT("material_add_reroute_usage"),
        TEXT("material_connect_nodes"),
        TEXT("material_compile"),
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
    if (Cmd == TEXT("material_add_reroute_declaration")) return MatAddRerouteDeclaration(P);
    if (Cmd == TEXT("material_add_reroute_usage"))       return MatAddRerouteUsage(P);
    if (Cmd == TEXT("material_connect_nodes"))  return MatConnectNodes(P);
    if (Cmd == TEXT("material_compile"))        return MatCompile(P);
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
    return false;
}

// Task 3: Set a single named field on an arbitrary struct instance by reflection.
// Covers the subset of field types needed for FCustomInput (FName/FString/bool/numeric).
static bool SetStructFieldByReflection(UScriptStruct* Struct, void* StructPtr, const FString& FieldName, const TSharedPtr<FJsonValue>& V)
{
    if (!Struct || !StructPtr || !V.IsValid()) return false;
    FProperty* Prop = Struct->FindPropertyByName(FName(*FieldName));
    if (!Prop) return false;

    if (FNameProperty* Nm = CastField<FNameProperty>(Prop)) { Nm->SetPropertyValue_InContainer(StructPtr, FName(*V->AsString())); return true; }
    if (FStrProperty* S = CastField<FStrProperty>(Prop)) { S->SetPropertyValue_InContainer(StructPtr, V->AsString()); return true; }
    if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
    {
        const bool bVal = (V->Type == EJson::Boolean) ? V->AsBool() : (V->AsNumber() != 0.0);
        B->SetPropertyValue_InContainer(StructPtr, bVal);
        return true;
    }
    if (FNumericProperty* N = CastField<FNumericProperty>(Prop))
    {
        void* Ptr = N->ContainerPtrToValuePtr<void>(StructPtr);
        if (N->IsFloatingPoint()) N->SetFloatingPointPropertyValue(Ptr, V->AsNumber());
        else N->SetIntPropertyValue(Ptr, (int64)V->AsNumber());
        return true;
    }
    return false;
}

// Generic reflection setter: set ANY UPROPERTY on the expression by its real
// name, coercing from the JSON value by property type. Covers enums-by-string
// (e.g. InputType="FunctionInput_Scalar"), bool bitfields (ComponentMask R/G/B/A),
// numerics, FName/FString, struct-from-array (LinearColor/Vector/Vector4f/Vector2D/Color),
// and object refs by asset path. Returns true if the property existed.
static bool SetPropByReflection(UObject* Target, const FString& Name, const TSharedPtr<FJsonValue>& V)
{
    if (!Target || !V.IsValid()) return false;
    FProperty* Prop = Target->GetClass()->FindPropertyByName(FName(*Name));
    if (!Prop) return false;
    void* Owner = Target;

    if (FBoolProperty* B = CastField<FBoolProperty>(Prop))
    {
        const bool bVal = (V->Type == EJson::Boolean) ? V->AsBool() : (V->AsNumber() != 0.0);
        B->SetPropertyValue_InContainer(Owner, bVal);
        return true;
    }
    if (FByteProperty* By = CastField<FByteProperty>(Prop))
    {
        if (V->Type == EJson::String && By->Enum)
        {
            int64 E = By->Enum->GetValueByNameString(V->AsString());
            if (E == INDEX_NONE)
            {
                const FString First = By->Enum->GetNameStringByIndex(0);
                int32 Underscore;
                if (First.FindChar('_', Underscore))
                    E = By->Enum->GetValueByNameString(First.Left(Underscore) + TEXT("_") + V->AsString());
            }
            if (E != INDEX_NONE) By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Owner), E);
        }
        else By->SetIntPropertyValue(By->ContainerPtrToValuePtr<void>(Owner), (int64)V->AsNumber());
        return true;
    }
    if (FEnumProperty* En = CastField<FEnumProperty>(Prop))
    {
        int64 Val = 0;
        if (V->Type == EJson::String && En->GetEnum())
        {
            Val = En->GetEnum()->GetValueByNameString(V->AsString());
            if (Val == INDEX_NONE) Val = 0;
        }
        else Val = (int64)V->AsNumber();
        En->GetUnderlyingProperty()->SetIntPropertyValue(En->ContainerPtrToValuePtr<void>(Owner), Val);
        return true;
    }
    if (FNumericProperty* N = CastField<FNumericProperty>(Prop))
    {
        void* Ptr = N->ContainerPtrToValuePtr<void>(Owner);
        if (N->IsFloatingPoint()) N->SetFloatingPointPropertyValue(Ptr, V->AsNumber());
        else N->SetIntPropertyValue(Ptr, (int64)V->AsNumber());
        return true;
    }
    if (FNameProperty* Nm = CastField<FNameProperty>(Prop)) { Nm->SetPropertyValue_InContainer(Owner, FName(*V->AsString())); return true; }
    if (FStrProperty* S = CastField<FStrProperty>(Prop)) { S->SetPropertyValue_InContainer(Owner, V->AsString()); return true; }
    if (FObjectProperty* O = CastField<FObjectProperty>(Prop))
    {
        if (V->Type == EJson::String)
            if (UObject* Obj = LoadObject<UObject>(nullptr, *V->AsString()))
                if (Obj->IsA(O->PropertyClass)) O->SetObjectPropertyValue_InContainer(Owner, Obj);
        return true;
    }
    if (FStructProperty* St = CastField<FStructProperty>(Prop))
    {
        if (V->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
            auto Num = [&A](int32 i) { return A.IsValidIndex(i) ? (float)A[i]->AsNumber() : 0.f; };
            void* Ptr = St->ContainerPtrToValuePtr<void>(Owner);
            const FString SN = St->Struct->GetName();
            if (SN == TEXT("LinearColor"))                        *(FLinearColor*)Ptr = FLinearColor(Num(0), Num(1), Num(2), A.Num() > 3 ? Num(3) : 1.f);
            else if (SN == TEXT("Vector"))                        *(FVector*)Ptr      = FVector(Num(0), Num(1), Num(2));
            else if (SN == TEXT("Vector4") || SN == TEXT("Vector4f")) *(FVector4f*)Ptr = FVector4f(Num(0), Num(1), Num(2), Num(3));
            else if (SN == TEXT("Vector2D"))                      *(FVector2D*)Ptr    = FVector2D(Num(0), Num(1));
            else if (SN == TEXT("Color"))                         *(FColor*)Ptr       = FColor((uint8)Num(0), (uint8)Num(1), (uint8)Num(2), A.Num() > 3 ? (uint8)Num(3) : 255);
        }
        return true;
    }
    // Task 3: TArray support — each element is a JSON object whose keys are set
    // via SetStructFieldByReflection. Primary use: MaterialExpressionCustom.Inputs
    // where each element is an FCustomInput struct with an InputName FName field.
    if (FArrayProperty* Arr = CastField<FArrayProperty>(Prop))
    {
        if (V->Type != EJson::Array) return false;  // don't claim success on a non-array value
        {
            FScriptArrayHelper Helper(Arr, Arr->ContainerPtrToValuePtr<void>(Owner));
            const TArray<TSharedPtr<FJsonValue>>& JArr = V->AsArray();
            Helper.Resize(JArr.Num());
            if (FStructProperty* InnerSt = CastField<FStructProperty>(Arr->Inner))
            {
                for (int32 i = 0; i < JArr.Num(); ++i)
                {
                    void* ElemPtr = Helper.GetRawPtr(i);
                    InnerSt->Struct->InitializeStruct(ElemPtr);
                    if (JArr[i].IsValid() && JArr[i]->Type == EJson::Object)
                    {
                        const TSharedPtr<FJsonObject>& ElemObj = JArr[i]->AsObject();
                        for (const TPair<FString, TSharedPtr<FJsonValue>>& F : ElemObj->Values)
                            SetStructFieldByReflection(InnerSt->Struct, ElemPtr, F.Key, F.Value);
                    }
                }
            }
        }
        return true;
    }
    return false;
}

// Apply optional per-node properties. Friendly aliases (parameter_name/default_value/
// texture/const/function/coordinate_index/u_tiling/v_tiling) are handled first for
// back-compat; every other key is treated as a real UPROPERTY name and set via
// reflection (SetPropByReflection) — so callers can set InputType, ComponentMask
// R/G/B/A, SortPriority, SamplerType, Desc, etc. with no per-type code here.
static void ApplyNodeProps(UMaterialExpression* Expr, const TSharedPtr<FJsonObject>& Props)
{
    if (!Expr || !Props.IsValid()) return;

    FString S;
    if (Props->TryGetStringField(TEXT("parameter_name"), S))
    {
        const FName PName(*S);
        if (UMaterialExpressionParameter* Par = Cast<UMaterialExpressionParameter>(Expr)) Par->ParameterName = PName;
        if (UMaterialExpressionTextureSampleParameter* Tp = Cast<UMaterialExpressionTextureSampleParameter>(Expr)) Tp->ParameterName = PName;
    }

    const TSharedPtr<FJsonValue> DV = Props->TryGetField(TEXT("default_value"));
    if (DV.IsValid())
    {
        if (UMaterialExpressionScalarParameter* Sc = Cast<UMaterialExpressionScalarParameter>(Expr); Sc && DV->Type == EJson::Number)
            Sc->DefaultValue = (float)DV->AsNumber();
        if (UMaterialExpressionStaticBoolParameter* Sb = Cast<UMaterialExpressionStaticBoolParameter>(Expr); Sb && DV->Type == EJson::Boolean)
            Sb->DefaultValue = DV->AsBool();
        if (UMaterialExpressionVectorParameter* Vp = Cast<UMaterialExpressionVectorParameter>(Expr); Vp && DV->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = DV->AsArray();
            FLinearColor C(0, 0, 0, 1);
            if (A.Num() > 0) C.R = A[0]->AsNumber();
            if (A.Num() > 1) C.G = A[1]->AsNumber();
            if (A.Num() > 2) C.B = A[2]->AsNumber();
            if (A.Num() > 3) C.A = A[3]->AsNumber();
            Vp->DefaultValue = C;
        }
    }

    FString TexPath;
    if (Props->TryGetStringField(TEXT("texture"), TexPath))
        if (UMaterialExpressionTextureBase* Ts = Cast<UMaterialExpressionTextureBase>(Expr))
            if (UTexture* Tex = LoadObject<UTexture>(nullptr, *TexPath)) Ts->Texture = Tex;

    const TSharedPtr<FJsonValue> CV = Props->TryGetField(TEXT("const"));
    if (CV.IsValid())
    {
        if (UMaterialExpressionConstant* C1 = Cast<UMaterialExpressionConstant>(Expr); C1 && CV->Type == EJson::Number)
            C1->R = (float)CV->AsNumber();
        if (CV->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = CV->AsArray();
            auto N = [&A](int32 i) { return A.IsValidIndex(i) ? (float)A[i]->AsNumber() : 0.f; };
            if (UMaterialExpressionConstant2Vector* C2 = Cast<UMaterialExpressionConstant2Vector>(Expr)) { C2->R = N(0); C2->G = N(1); }
            if (UMaterialExpressionConstant3Vector* C3 = Cast<UMaterialExpressionConstant3Vector>(Expr)) C3->Constant = FLinearColor(N(0), N(1), N(2), 1.f);
            if (UMaterialExpressionConstant4Vector* C4 = Cast<UMaterialExpressionConstant4Vector>(Expr)) C4->Constant = FLinearColor(N(0), N(1), N(2), N(3));
        }
    }

    FString FuncPath;
    if (Props->TryGetStringField(TEXT("function"), FuncPath))
        if (UMaterialExpressionMaterialFunctionCall* Fc = Cast<UMaterialExpressionMaterialFunctionCall>(Expr))
            if (UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath))
                Fc->SetMaterialFunction(Fn);

    if (UMaterialExpressionTextureCoordinate* Tc = Cast<UMaterialExpressionTextureCoordinate>(Expr))
    {
        double D;
        if (Props->TryGetNumberField(TEXT("coordinate_index"), D)) Tc->CoordinateIndex = (int32)D;
        if (Props->TryGetNumberField(TEXT("u_tiling"), D)) Tc->UTiling = (float)D;
        if (Props->TryGetNumberField(TEXT("v_tiling"), D)) Tc->VTiling = (float)D;
    }

    // FunctionInput/Output naming (Task 4) reuses parameter_name.
    if (Props->TryGetStringField(TEXT("parameter_name"), S))
    {
        if (UMaterialExpressionFunctionInput* In = Cast<UMaterialExpressionFunctionInput>(Expr)) In->InputName = FName(*S);
        if (UMaterialExpressionFunctionOutput* O = Cast<UMaterialExpressionFunctionOutput>(Expr)) O->OutputName = FName(*S);
    }

    // Generic reflection passthrough: any key that isn't a friendly alias is
    // treated as a real UPROPERTY name (e.g. InputType, R/G/B/A, SortPriority,
    // SamplerType, ConstCoordinate, Desc). Aliases above are skipped here.
    static const TSet<FString> Aliases = {
        TEXT("parameter_name"), TEXT("default_value"), TEXT("texture"),
        TEXT("const"), TEXT("function"), TEXT("coordinate_index"),
        TEXT("u_tiling"), TEXT("v_tiling"),
    };
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Props->Values)
    {
        if (Aliases.Contains(Pair.Key)) continue;
        SetPropByReflection(Expr, Pair.Key, Pair.Value);
    }

    Expr->PostEditChange();
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCreate(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
    FString Dir = FPackageName::GetLongPackagePath(PkgPath);
    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterial::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_create: CreateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatFunctionCreate(const TSharedPtr<FJsonObject>& P)
{
    FString PkgPath, Name;
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath) || PkgPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_function_create: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("material_function_create: missing name"));

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    UMaterialFunctionFactoryNew* Factory = NewObject<UMaterialFunctionFactoryNew>();
    FString Dir = FPackageName::GetLongPackagePath(PkgPath);
    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterialFunction::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_function_create: CreateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    Out->SetStringField(TEXT("name"), Name);
    return FHaybaHandlerResult::Ok(Out);
}

// Spread auto-placed nodes (no explicit node_pos) over a grid keyed off the
// count of existing expressions, instead of stacking every new node at (0,0).
// Inputs flow left->right toward the output, so new nodes start far left and
// wrap into rows. Explicit node_pos always overrides this.
static void HaybaAutoNodePos(int32 ExistingCount, int32& X, int32& Y)
{
    constexpr int32 Cols = 6;
    constexpr int32 DX = 320;   // horizontal spacing (wider than a typical node)
    constexpr int32 DY = 260;   // vertical spacing (taller than a texture-sample node)
    constexpr int32 OriginX = -1700;
    constexpr int32 OriginY = -600;
    X = OriginX + (ExistingCount % Cols) * DX;
    Y = OriginY + (ExistingCount / Cols) * DY;
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString ExprClass;
    if (!P->TryGetStringField(TEXT("expression_class"), ExprClass)) return FHaybaHandlerResult::Err(TEXT("material_add_node: missing expression_class"));

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
        if (PropsObj) ApplyNodeProps(Expr, *PropsObj);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), Expr->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_node: missing material_path or function_path"));

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_node: material not found"));

    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpression(Mat, ExprCls, X, Y);
    if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpression failed"));
    if (PropsObj) ApplyNodeProps(Expr, *PropsObj);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), Expr->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatConnectNodes(const TSharedPtr<FJsonObject>& P)
{
    FString FromNode;
    if (!P->TryGetStringField(TEXT("from_node"), FromNode)) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing from_node"));

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
    { double D; if (P->TryGetNumberField(TEXT("to_input_index"), D)) ToInputIndex = (int32)D; }
    { double D; if (P->TryGetNumberField(TEXT("from_output_index"), D)) FromOutputIndex = (int32)D; }
    auto ConnectByIndex = [&](UMaterialExpression* From, UMaterialExpression* To) -> bool {
        FExpressionInput* In = To->GetInput(ToInputIndex);
        if (!In) return false;
        In->Connect(FromOutputIndex, From);
        return true;
    };

    // Material-Function target (Task 4).
    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: function not found"));
        UMaterialExpression* From = FindExprByNameInFunction(Fn, FromNode);
        if (!From) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: from_node not found: %s"), *FromNode));
        if (!bHasTo) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: function connections require to_node"));
        UMaterialExpression* To = FindExprByNameInFunction(Fn, ToNode);
        if (!To) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_node not found: %s"), *ToNode));
        if (ToInputIndex >= 0)
        {
            if (!ConnectByIndex(From, To)) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: to_input_index out of range"));
        }
        else if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, FromOutput, To, ToInput))
            return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: ConnectMaterialExpressions failed"));
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("connected"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: material not found"));

    UMaterialExpression* From = FindExprByName(Mat, FromNode);
    if (!From) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: from_node not found: %s"), *FromNode));

    if (bHasProp)
    {
        EMaterialProperty Prop;
        if (!TryParseProperty(PropStr, Prop))
            return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: unknown to_property: %s"), *PropStr));
        if (!UMaterialEditingLibrary::ConnectMaterialProperty(From, FromOutput, Prop))
            return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: ConnectMaterialProperty failed"));
    }
    else
    {
        if (!bHasTo) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: missing to_node or to_property"));
        UMaterialExpression* To = FindExprByName(Mat, ToNode);
        if (!To) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_connect_nodes: to_node not found: %s"), *ToNode));
        if (ToInputIndex >= 0)
        {
            if (!ConnectByIndex(From, To)) return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: to_input_index out of range"));
        }
        else if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, FromOutput, To, ToInput))
            return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: ConnectMaterialExpressions failed"));
    }

    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("connected"), true);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCreateInstance(const TSharedPtr<FJsonObject>& P)
{
    FString ParentPath, PkgPath, Name;
    if (!P->TryGetStringField(TEXT("parent_material_path"), ParentPath)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing parent_material_path"));
    if (!P->TryGetStringField(TEXT("package_path"), PkgPath)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing package_path"));
    if (!P->TryGetStringField(TEXT("name"), Name)) return FHaybaHandlerResult::Err(TEXT("material_create_instance: missing name"));

    UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr, *ParentPath);
    if (!Parent) return FHaybaHandlerResult::Err(TEXT("material_create_instance: parent material not found"));

    UMaterialInstanceConstantFactoryNew* Factory = NewObject<UMaterialInstanceConstantFactoryNew>();
    Factory->InitialParent = Parent;

    IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
    FString Dir = FPackageName::GetLongPackagePath(PkgPath);
    UObject* Created = Tools.CreateAsset(Name, Dir, UMaterialInstanceConstant::StaticClass(), Factory);
    if (!Created) return FHaybaHandlerResult::Err(TEXT("material_create_instance: CreateAsset failed"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("path"), Created->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetParam(const TSharedPtr<FJsonObject>& P)
{
    FString InstPath, ParamName;
    if (!P->TryGetStringField(TEXT("instance_path"), InstPath)) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing instance_path"));
    if (!P->TryGetStringField(TEXT("param_name"), ParamName)) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing param_name"));

    UMaterialInstanceConstant* MIC = LoadObject<UMaterialInstanceConstant>(nullptr, *InstPath);
    if (!MIC) return FHaybaHandlerResult::Err(TEXT("material_set_param: instance not found"));

    TSharedPtr<FJsonValue> Val = P->TryGetField(TEXT("value"));
    if (!Val.IsValid()) return FHaybaHandlerResult::Err(TEXT("material_set_param: missing value"));

    FName PName(*ParamName);
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("param"), ParamName);

    if (Val->Type == EJson::Number)
    {
        MIC->SetScalarParameterValueEditorOnly(PName, (float)Val->AsNumber());
        Out->SetNumberField(TEXT("value"), Val->AsNumber());
    }
    else if (Val->Type == EJson::Array)
    {
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
        if (!bFound)
        {
            // Parameter not yet in the override set — add it.
            FStaticSwitchParameter NewSP;
            NewSP.ParameterInfo.Name = PName;
            NewSP.Value = bSwitch;
            NewSP.bOverride = true;
            StaticParams.StaticSwitchParameters.Add(NewSP);
        }
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
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId)) return FHaybaHandlerResult::Err(TEXT("material_apply: missing actor_id"));
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_apply: missing material_path"));
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
static TArray<TSharedPtr<FJsonValue>> SerializeMaterialExpressions(const TExprRange& InExprs)
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
            ++InputIdx;
            Inputs.Add(MakeShared<FJsonValueObject>(InEntry.ToSharedRef()));
        }
        Entry->SetArrayField(TEXT("inputs"), Inputs);
        Exprs.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }
    return Exprs;
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("material_get_info: missing path"));

    // UMaterial first, then fall back to UMaterialFunction (same GetExpressions()
    // graph API). Material instances are not handled here (they have no graph).
    if (UMaterial* Mat = LoadObject<UMaterial>(nullptr, *Path))
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("kind"), TEXT("material"));
        Out->SetStringField(TEXT("name"), Mat->GetName());
        Out->SetArrayField(TEXT("expressions"), SerializeMaterialExpressions(Mat->GetExpressions()));
        Out->SetNumberField(TEXT("shading_model"), (int32)Mat->GetShadingModels().GetFirstShadingModel());
        return FHaybaHandlerResult::Ok(Out);
    }

    if (UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *Path))
    {
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("kind"), TEXT("function"));
        Out->SetStringField(TEXT("name"), Fn->GetName());
        Out->SetStringField(TEXT("description"), Fn->Description);
        Out->SetArrayField(TEXT("expressions"), SerializeMaterialExpressions(Fn->GetExpressions()));
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
    if (!P->TryGetStringField(TEXT("node_id"), NodeId)) return FHaybaHandlerResult::Err(TEXT("material_set_node: missing node_id"));

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

    auto ApplyTo = [&](UMaterialExpression* Expr) {
        if (bHasPos) { Expr->MaterialExpressionEditorX = X; Expr->MaterialExpressionEditorY = Y; }
        if (PropsObj) ApplyNodeProps(Expr, *PropsObj);
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
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), NodeId);
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_set_node: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_set_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_set_node: node not found: %s"), *NodeId));
    ApplyTo(Expr);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), NodeId);
    return FHaybaHandlerResult::Ok(Out);
}

// Delete an existing node by id, in a material or function.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDeleteNode(const TSharedPtr<FJsonObject>& P)
{
    FString NodeId;
    if (!P->TryGetStringField(TEXT("node_id"), NodeId)) return FHaybaHandlerResult::Err(TEXT("material_delete_node: missing node_id"));

    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_delete_node: function not found"));
        UMaterialExpression* Expr = FindExprByNameInFunction(Fn, NodeId);
        if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
        UMaterialEditingLibrary::DeleteMaterialExpressionInFunction(Fn, Expr);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetBoolField(TEXT("deleted"), true);
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_delete_node: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_delete_node: material not found"));
    UMaterialExpression* Expr = FindExprByName(Mat, NodeId);
    if (!Expr) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_delete_node: node not found: %s"), *NodeId));
    UMaterialEditingLibrary::DeleteMaterialExpression(Mat, Expr);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
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
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("comment_id"), C->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_comment: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_comment: material not found"));
    UMaterialExpressionComment* C = NewObject<UMaterialExpressionComment>(Mat);
    Setup(C);
    Mat->GetExpressionCollection().AddComment(C);
    // Comments don't affect compilation; persist to disk (no PostEditChange,
    // which would needlessly translate the material).
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("comment_id"), C->GetName());
    return FHaybaHandlerResult::Ok(Out);
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
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), D->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: missing material_path or function_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: material not found"));
    if (!bHasPos) HaybaAutoNodePos(Mat->GetExpressions().Num(), X, Y);
    UMaterialExpressionNamedRerouteDeclaration* D = Cast<UMaterialExpressionNamedRerouteDeclaration>(UMaterialEditingLibrary::CreateMaterialExpression(Mat, Cls, X, Y));
    if (!D) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_declaration: create failed"));
    Setup(D);
    // Deferred-compile + crash-resilient save: no per-edit RecompileMaterial
    // (avoids translating a half-built graph -> editor-killing assert). Persist
    // to disk now; translate via the explicit material_compile command.
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
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
        { FString SaveErr; HaybaPersistAsset(Fn, SaveErr); }  // crash-resilient: save function graph now
        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), U->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_reroute_usage: missing material_path or function_path"));
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
    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("node_id"), U->GetName());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatSetProperty(const TSharedPtr<FJsonObject>& P)
{
    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath))
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
    };

    TArray<TSharedPtr<FJsonValue>> Applied;
    for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*PropsObj)->Values)
    {
        const FString* Real = Aliases.Find(Pair.Key);
        const FString RealName = Real ? *Real : Pair.Key;
        if (SetPropByReflection(Mat, RealName, Pair.Value))
            Applied.Add(MakeShared<FJsonValueString>(Pair.Key));
    }

    // Deferred-compile: persist the changed settings to disk; the translate
    // (which applies the new BlendMode/Domain/etc. and could assert) happens on
    // the explicit material_compile call, not here.
    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Mat, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("applied"), Applied);
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

// Explicit, deferred compile. This is the ONE place the master-material graph
// is translated (the per-edit handlers only save). PostEditChange applies any
// settings staged by material_set_property; RecompileMaterial forces the shader
// translate so compile errors surface. A truly pathological graph can still hit
// an engine check() here and crash — but every prior edit was already saved to
// disk, so the AI's progress is recoverable on restart. Returns the translator
// errors so the agent gets feedback instead of guessing.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatCompile(const TSharedPtr<FJsonObject>& P)
{
    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath))
        return FHaybaHandlerResult::Err(TEXT("material_compile: missing material_path"));
    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_compile: material not found"));

    Mat->PostEditChange();
    UMaterialEditingLibrary::RecompileMaterial(Mat);

    TArray<TSharedPtr<FJsonValue>> Errs;
    if (FMaterialResource* Res = Mat->GetMaterialResource(GMaxRHIShaderPlatform))
        for (const FString& E : Res->GetCompileErrors())
            Errs.Add(MakeShared<FJsonValueString>(E));

    FString SaveErr;
    const bool bSaved = HaybaPersistAsset(Mat, SaveErr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("errors"), Errs);
    Out->SetBoolField(TEXT("has_errors"), Errs.Num() > 0);
    Out->SetBoolField(TEXT("saved"), bSaved);
    if (!bSaved) Out->SetStringField(TEXT("save_error"), SaveErr);
    return FHaybaHandlerResult::Ok(Out);
}

// Task 4: material_disconnect — clear an input connection on a node or a
// material-output property connection. Mirrors material_connect_nodes in
// param shape; requires either to_node (+ optional to_input/to_input_index)
// or to_property.
FHaybaHandlerResult FHaybaMCPMaterialHandler::MatDisconnect(const TSharedPtr<FJsonObject>& P)
{
    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath))
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

    { FString SaveErr; HaybaPersistAsset(Mat, SaveErr); }
    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("disconnected"), true);
    return FHaybaHandlerResult::Ok(Out);
}
