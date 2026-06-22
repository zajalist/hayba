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
// Graph authoring (Tasks 2-4): connections, node properties, material functions
#include "MaterialEditingLibrary.h"
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

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPMaterial, Log, All);

TArray<FString> FHaybaMCPMaterialHandler::GetCommands() const
{
    return {
        TEXT("material_create"),
        TEXT("material_function_create"),
        TEXT("material_add_node"),
        TEXT("material_connect_nodes"),
        TEXT("material_create_instance"),
        TEXT("material_set_param"),
        TEXT("material_apply"),
        TEXT("material_list"),
        TEXT("material_get_info"),
    };
}

FHaybaHandlerResult FHaybaMCPMaterialHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("material_create"))         return MatCreate(P);
    if (Cmd == TEXT("material_function_create")) return MatFunctionCreate(P);
    if (Cmd == TEXT("material_add_node"))       return MatAddNode(P);
    if (Cmd == TEXT("material_connect_nodes"))  return MatConnectNodes(P);
    if (Cmd == TEXT("material_create_instance")) return MatCreateInstance(P);
    if (Cmd == TEXT("material_set_param"))      return MatSetParam(P);
    if (Cmd == TEXT("material_apply"))          return MatApply(P);
    if (Cmd == TEXT("material_list"))           return MatList(P);
    if (Cmd == TEXT("material_get_info"))       return MatGetInfo(P);
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
    return false;
}

// Apply optional per-node properties (Task 3). Unknown keys are ignored so the
// schema stays forward-compatible.
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

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatAddNode(const TSharedPtr<FJsonObject>& P)
{
    FString ExprClass;
    if (!P->TryGetStringField(TEXT("expression_class"), ExprClass)) return FHaybaHandlerResult::Err(TEXT("material_add_node: missing expression_class"));

    UClass* ExprCls = FindFirstObjectSafe<UClass>(*ExprClass);
    if (!ExprCls) return FHaybaHandlerResult::Err(FString::Printf(TEXT("material_add_node: class not found: %s"), *ExprClass));

    int32 X = 0, Y = 0;
    const TArray<TSharedPtr<FJsonValue>>* Pos;
    if (P->TryGetArrayField(TEXT("node_pos"), Pos) && Pos->Num() >= 2)
    {
        X = (int32)(*Pos)[0]->AsNumber();
        Y = (int32)(*Pos)[1]->AsNumber();
    }

    const TSharedPtr<FJsonObject>* PropsObj = nullptr;
    P->TryGetObjectField(TEXT("properties"), PropsObj);

    // Material-Function target (Task 4) takes precedence when supplied.
    FString FuncPath;
    if (P->TryGetStringField(TEXT("function_path"), FuncPath) && !FuncPath.IsEmpty())
    {
        UMaterialFunction* Fn = LoadObject<UMaterialFunction>(nullptr, *FuncPath);
        if (!Fn) return FHaybaHandlerResult::Err(TEXT("material_add_node: function not found"));
        UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpressionInFunction(Fn, ExprCls, X, Y);
        if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpressionInFunction failed"));
        if (PropsObj) ApplyNodeProps(Expr, *PropsObj);
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);

        TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
        Out->SetStringField(TEXT("node_id"), Expr->GetName());
        return FHaybaHandlerResult::Ok(Out);
    }

    FString MatPath;
    if (!P->TryGetStringField(TEXT("material_path"), MatPath)) return FHaybaHandlerResult::Err(TEXT("material_add_node: missing material_path or function_path"));

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *MatPath);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_add_node: material not found"));

    UMaterialExpression* Expr = UMaterialEditingLibrary::CreateMaterialExpression(Mat, ExprCls, X, Y);
    if (!Expr) return FHaybaHandlerResult::Err(TEXT("material_add_node: CreateMaterialExpression failed"));
    if (PropsObj) ApplyNodeProps(Expr, *PropsObj);
    Mat->MarkPackageDirty();
    UMaterialEditingLibrary::RecompileMaterial(Mat);

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
        if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, FromOutput, To, ToInput))
            return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: ConnectMaterialExpressions failed"));
        UMaterialEditingLibrary::UpdateMaterialFunction(Fn, nullptr);

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
        if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, FromOutput, To, ToInput))
            return FHaybaHandlerResult::Err(TEXT("material_connect_nodes: ConnectMaterialExpressions failed"));
    }

    Mat->MarkPackageDirty();
    UMaterialEditingLibrary::RecompileMaterial(Mat);

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
    else return FHaybaHandlerResult::Err(TEXT("material_set_param: unsupported value type"));

    MIC->PostEditChange();
    MIC->MarkPackageDirty();
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

FHaybaHandlerResult FHaybaMCPMaterialHandler::MatGetInfo(const TSharedPtr<FJsonObject>& P)
{
    FString Path;
    if (!P->TryGetStringField(TEXT("path"), Path)) return FHaybaHandlerResult::Err(TEXT("material_get_info: missing path"));

    UMaterial* Mat = LoadObject<UMaterial>(nullptr, *Path);
    if (!Mat) return FHaybaHandlerResult::Err(TEXT("material_get_info: material not found"));

    TArray<TSharedPtr<FJsonValue>> Exprs;
    for (UMaterialExpression* Expr : Mat->GetExpressions())
    {
        if (!Expr) continue;
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("id"),    Expr->GetName());
        Entry->SetStringField(TEXT("class"), Expr->GetClass()->GetName());

        TArray<TSharedPtr<FJsonValue>> Inputs;
        int32 InputIdx = 0;
        for (FExpressionInputIterator It{Expr}; It; ++It)
        {
            TSharedPtr<FJsonObject> InEntry = MakeShared<FJsonObject>();
            const FString InputName = It->InputName.IsNone()
                ? FString::Printf(TEXT("input_%d"), InputIdx)
                : It->InputName.ToString();
            InEntry->SetStringField(TEXT("name"), InputName);
            InEntry->SetBoolField(TEXT("connected"), It->Expression != nullptr);
            ++InputIdx;
            Inputs.Add(MakeShared<FJsonValueObject>(InEntry.ToSharedRef()));
        }
        Entry->SetArrayField(TEXT("inputs"), Inputs);
        Exprs.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("name"), Mat->GetName());
    Out->SetArrayField(TEXT("expressions"), Exprs);
    Out->SetNumberField(TEXT("shading_model"), (int32)Mat->GetShadingModels().GetFirstShadingModel());
    return FHaybaHandlerResult::Ok(Out);
}
