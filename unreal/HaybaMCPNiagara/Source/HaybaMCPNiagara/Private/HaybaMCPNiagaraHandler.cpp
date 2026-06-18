#include "HaybaMCPNiagaraHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "NiagaraSystem.h"
#include "NiagaraComponent.h"
#include "NiagaraFunctionLibrary.h"
#include "UObject/UObjectGlobals.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPNiagara, Log, All);

TArray<FString> FHaybaMCPNiagaraHandler::GetCommands() const
{
    return {
        TEXT("niagara_list"),
        TEXT("niagara_spawn"),
        TEXT("niagara_set_param")
    };
}

FHaybaHandlerResult FHaybaMCPNiagaraHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("niagara_list"))      return NiagaraList(P);
    if (Cmd == TEXT("niagara_spawn"))     return NiagaraSpawn(P);
    if (Cmd == TEXT("niagara_set_param")) return NiagaraSetParam(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("NiagaraHandler: unknown command %s"), *Cmd));
}

static UWorld* GetEditorOrGameWorld()
{
    if (GEditor)
    {
        if (UWorld* W = GEditor->GetEditorWorldContext().World()) return W;
    }
    return GWorld;
}

static AActor* FindActorByName(UWorld* World, const FString& Name)
{
    if (!World) return nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
        if ((*It)->GetName() == Name) return *It;
    return nullptr;
}

static bool ReadVec3(const TSharedPtr<FJsonObject>& Obj, FVector& Out)
{
    if (!Obj.IsValid()) return false;
    double X=0, Y=0, Z=0;
    Obj->TryGetNumberField(TEXT("x"), X);
    Obj->TryGetNumberField(TEXT("y"), Y);
    Obj->TryGetNumberField(TEXT("z"), Z);
    Out = FVector(X, Y, Z);
    return true;
}

static bool ReadRot(const TSharedPtr<FJsonObject>& Obj, FRotator& Out)
{
    if (!Obj.IsValid()) return false;
    double P=0, Y=0, R=0;
    Obj->TryGetNumberField(TEXT("p"), P);
    Obj->TryGetNumberField(TEXT("y"), Y);
    Obj->TryGetNumberField(TEXT("r"), R);
    Out = FRotator(P, Y, R);
    return true;
}

FHaybaHandlerResult FHaybaMCPNiagaraHandler::NiagaraList(const TSharedPtr<FJsonObject>& P)
{
    FString PathPrefix;
    P->TryGetStringField(TEXT("path_prefix"), PathPrefix);

    IAssetRegistry& AR = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    TArray<FAssetData> Assets;
    AR.GetAssetsByClass(UNiagaraSystem::StaticClass()->GetClassPathName(), Assets);

    TArray<TSharedPtr<FJsonValue>> Out;
    for (const FAssetData& A : Assets)
    {
        const FString ObjPath = A.GetObjectPathString();
        if (!PathPrefix.IsEmpty() && !ObjPath.StartsWith(PathPrefix)) continue;
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("path"), ObjPath);
        Entry->SetStringField(TEXT("name"), A.AssetName.ToString());
        Out.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetArrayField(TEXT("systems"), Out);
    Result->SetNumberField(TEXT("count"), Out.Num());
    return FHaybaHandlerResult::Ok(Result);
}

FHaybaHandlerResult FHaybaMCPNiagaraHandler::NiagaraSpawn(const TSharedPtr<FJsonObject>& P)
{
    FString SysPath;
    if (!P->TryGetStringField(TEXT("system_path"), SysPath) || SysPath.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("niagara_spawn: missing system_path"));

    UNiagaraSystem* Sys = LoadObject<UNiagaraSystem>(nullptr, *SysPath);
    if (!Sys) return FHaybaHandlerResult::Err(FString::Printf(TEXT("niagara_spawn: system not found: %s"), *SysPath));

    FVector Loc(0,0,0);
    FRotator Rot(0,0,0);
    const TSharedPtr<FJsonObject>* LocObj = nullptr;
    if (P->TryGetObjectField(TEXT("location"), LocObj)) ReadVec3(*LocObj, Loc);
    const TSharedPtr<FJsonObject>* RotObj = nullptr;
    if (P->TryGetObjectField(TEXT("rotation"), RotObj)) ReadRot(*RotObj, Rot);

    UWorld* World = GetEditorOrGameWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("niagara_spawn: no world"));

    UNiagaraComponent* Comp = UNiagaraFunctionLibrary::SpawnSystemAtLocation(
        World, Sys, Loc, Rot, FVector(1.f), /*bAutoDestroy*/true, /*bAutoActivate*/true);
    if (!Comp) return FHaybaHandlerResult::Err(TEXT("niagara_spawn: SpawnSystemAtLocation returned null"));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("spawned_path"), Sys->GetPathName());
    Out->SetStringField(TEXT("component_path"), Comp->GetPathName());
    if (AActor* Owner = Comp->GetOwner())
        Out->SetStringField(TEXT("actor_path"), Owner->GetPathName());
    return FHaybaHandlerResult::Ok(Out);
}

static UNiagaraComponent* ResolveNiagaraComponent(const TSharedPtr<FJsonObject>& P)
{
    FString CompPath;
    if (P->TryGetStringField(TEXT("component_path"), CompPath) && !CompPath.IsEmpty())
    {
        if (UNiagaraComponent* C = FindObject<UNiagaraComponent>(nullptr, *CompPath)) return C;
        if (UObject* O = StaticFindObject(UNiagaraComponent::StaticClass(), nullptr, *CompPath))
            return Cast<UNiagaraComponent>(O);
    }
    FString ActorPath;
    if (P->TryGetStringField(TEXT("actor_path"), ActorPath) && !ActorPath.IsEmpty())
    {
        UWorld* World = GetEditorOrGameWorld();
        AActor* Actor = nullptr;
        if (UObject* O = StaticFindObject(AActor::StaticClass(), nullptr, *ActorPath))
            Actor = Cast<AActor>(O);
        if (!Actor) Actor = FindActorByName(World, FPaths::GetBaseFilename(ActorPath));
        if (Actor) return Actor->FindComponentByClass<UNiagaraComponent>();
    }
    return nullptr;
}

FHaybaHandlerResult FHaybaMCPNiagaraHandler::NiagaraSetParam(const TSharedPtr<FJsonObject>& P)
{
    FString ParamName, ValueType;
    if (!P->TryGetStringField(TEXT("param_name"), ParamName) || ParamName.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("niagara_set_param: missing param_name"));
    if (!P->TryGetStringField(TEXT("value_type"), ValueType) || ValueType.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("niagara_set_param: missing value_type"));

    UNiagaraComponent* Comp = ResolveNiagaraComponent(P);
    if (!Comp) return FHaybaHandlerResult::Err(TEXT("niagara_set_param: niagara component not found"));

    TSharedPtr<FJsonValue> Val = P->TryGetField(TEXT("value"));
    if (!Val.IsValid()) return FHaybaHandlerResult::Err(TEXT("niagara_set_param: missing value"));

    FName PName(*ParamName);
    const FString VT = ValueType.ToLower();

    if (VT == TEXT("float"))
    {
        Comp->SetVariableFloat(PName, (float)Val->AsNumber());
    }
    else if (VT == TEXT("int") || VT == TEXT("int32") || VT == TEXT("integer"))
    {
        Comp->SetVariableInt(PName, (int32)Val->AsNumber());
    }
    else if (VT == TEXT("bool") || VT == TEXT("boolean"))
    {
        Comp->SetVariableBool(PName, Val->AsBool());
    }
    else if (VT == TEXT("vector") || VT == TEXT("vec3"))
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
        FVector V(0,0,0);
        if (Val->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = Val->AsArray();
            if (A.Num() > 0) V.X = A[0]->AsNumber();
            if (A.Num() > 1) V.Y = A[1]->AsNumber();
            if (A.Num() > 2) V.Z = A[2]->AsNumber();
        }
        else if (Val->Type == EJson::Object)
        {
            ReadVec3(Val->AsObject(), V);
        }
        else return FHaybaHandlerResult::Err(TEXT("niagara_set_param: vector expects array or object"));
        Comp->SetVariableVec3(PName, V);
        (void)Arr;
    }
    else if (VT == TEXT("color") || VT == TEXT("linearcolor"))
    {
        FLinearColor C(0,0,0,1);
        if (Val->Type == EJson::Array)
        {
            const TArray<TSharedPtr<FJsonValue>>& A = Val->AsArray();
            if (A.Num() > 0) C.R = A[0]->AsNumber();
            if (A.Num() > 1) C.G = A[1]->AsNumber();
            if (A.Num() > 2) C.B = A[2]->AsNumber();
            if (A.Num() > 3) C.A = A[3]->AsNumber();
        }
        else return FHaybaHandlerResult::Err(TEXT("niagara_set_param: color expects array [r,g,b,a]"));
        Comp->SetVariableLinearColor(PName, C);
    }
    else if (VT == TEXT("object") || VT == TEXT("asset"))
    {
        FString ObjPath = Val->AsString();
        UObject* Obj = StaticLoadObject(UObject::StaticClass(), nullptr, *ObjPath);
        if (!Obj) return FHaybaHandlerResult::Err(FString::Printf(TEXT("niagara_set_param: object not found: %s"), *ObjPath));
        Comp->SetVariableObject(PName, Obj);
    }
    else
    {
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("niagara_set_param: unsupported value_type: %s"), *ValueType));
    }

    Comp->MarkRenderStateDirty();

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("component_path"), Comp->GetPathName());
    Out->SetStringField(TEXT("param_name"), ParamName);
    Out->SetStringField(TEXT("value_type"), ValueType);
    return FHaybaHandlerResult::Ok(Out);
}
