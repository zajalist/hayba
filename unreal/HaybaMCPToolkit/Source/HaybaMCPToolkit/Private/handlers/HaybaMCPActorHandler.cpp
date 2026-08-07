#include "HaybaMCPActorHandler.h"
#include "HaybaActorOps.h"
#include "HaybaMCPParams.h"
#include "HaybaMCPReflection.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Subsystems/EditorActorSubsystem.h"
#include "Engine/OverlapResult.h"
#include "GameFramework/Actor.h"
#include "Components/StaticMeshComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/World.h"
#include "UObject/Class.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPActor, Log, All);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

AActor* FHaybaMCPActorHandler::FindActorByName(UWorld* World, const FString& Name) const
{
    if (!World) return nullptr;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if ((*It)->GetName() == Name)
            return *It;
    }
    return nullptr;
}

FVector FHaybaMCPActorHandler::ParseVec3(const TArray<TSharedPtr<FJsonValue>>& Arr, const FVector& Default) const
{
    if (Arr.Num() < 3) return Default;
    return FVector(
        Arr[0]->AsNumber(),
        Arr[1]->AsNumber(),
        Arr[2]->AsNumber()
    );
}

TSharedPtr<FJsonObject> FHaybaMCPActorHandler::VecToJson(const FVector& V) const
{
    TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
    Obj->SetNumberField(TEXT("x"), V.X);
    Obj->SetNumberField(TEXT("y"), V.Y);
    Obj->SetNumberField(TEXT("z"), V.Z);
    return Obj;
}

TSharedPtr<FJsonObject> FHaybaMCPActorHandler::RotToJson(const FRotator& R) const
{
    TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
    Obj->SetNumberField(TEXT("pitch"), R.Pitch);
    Obj->SetNumberField(TEXT("yaw"),   R.Yaw);
    Obj->SetNumberField(TEXT("roll"),  R.Roll);
    return Obj;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

TArray<FString> FHaybaMCPActorHandler::GetCommands() const
{
    return {
        TEXT("actor_spawn"),
        TEXT("actor_delete"),
        TEXT("actor_transform"),
        TEXT("actor_list"),
        TEXT("actor_get_properties"),
        TEXT("actor_set_properties"),
        TEXT("actor_tag"),
        TEXT("actor_snap_to_socket"),
        TEXT("actor_duplicate"),
        TEXT("actor_set_visibility"),
        TEXT("actor_get_components"),
        TEXT("actor_call_function"),
        TEXT("actor_batch_spawn"),
        TEXT("placement_validate"),
    };
}

FHaybaHandlerResult FHaybaMCPActorHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params)
{
    if (Cmd == TEXT("actor_spawn"))           return Spawn(Params);
    if (Cmd == TEXT("actor_delete"))          return Delete(Params);
    if (Cmd == TEXT("actor_transform"))       return Transform(Params);
    if (Cmd == TEXT("actor_list"))            return List(Params);
    if (Cmd == TEXT("actor_get_properties"))  return GetProps(Params);
    if (Cmd == TEXT("actor_set_properties"))  return SetProps(Params);
    if (Cmd == TEXT("actor_tag"))             return Tag(Params);
    if (Cmd == TEXT("actor_snap_to_socket"))  return SnapToSocket(Params);
    if (Cmd == TEXT("actor_duplicate"))       return Duplicate(Params);
    if (Cmd == TEXT("actor_set_visibility"))  return SetVisibility(Params);
    if (Cmd == TEXT("actor_get_components"))  return GetComponents(Params);
    if (Cmd == TEXT("actor_call_function"))   return CallFunction(Params);
    if (Cmd == TEXT("actor_batch_spawn"))     return BatchSpawn(Params);
    if (Cmd == TEXT("placement_validate"))    return ValidatePlacement(Params);

    return FHaybaHandlerResult::Err(FString::Printf(TEXT("ActorHandler: unknown command %s"), *Cmd));
}

// ---------------------------------------------------------------------------
// actor_spawn
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::Spawn(const TSharedPtr<FJsonObject>& P)
{
    // Adapter: read params, call the domain, shape the reply. No UE object
    // handling here and no JSON below. See HaybaActorOps.h.
    FHaybaParamReader R(P, TEXT("actor_spawn"));
    const HaybaActorOps::FSpawnRequest Req = HaybaActorOps::ParseSpawn(R);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    const HaybaActorOps::FSpawnResult Res = HaybaActorOps::Spawn(Req);
    if (!Res.bOk) return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_spawn: %s"), *Res.Error));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Res.ActorId);
    Out->SetStringField(TEXT("label"),    Res.Label);
    Out->SetStringField(TEXT("class"),    Res.ClassName);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_delete
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::Delete(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("actor_delete"));
    const FString ActorId = R.RequiredString(TEXT("actor_id"));
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    const HaybaActorOps::FDeleteResult Res = HaybaActorOps::Delete(ActorId);
    if (!Res.bOk) return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_delete: %s"), *Res.Error));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("deleted"), true);
    Out->SetStringField(TEXT("actor_id"), ActorId);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_transform
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::Transform(const TSharedPtr<FJsonObject>& P)
{
    FHaybaParamReader R(P, TEXT("actor_transform"));
    const HaybaActorOps::FTransformRequest Req = HaybaActorOps::ParseTransform(R);
    if (R.HasErrors()) return FHaybaHandlerResult::Err(R.ErrorMessage());

    const HaybaActorOps::FTransformResult Res = HaybaActorOps::Transform(Req);
    if (!Res.bOk) return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_transform: %s"), *Res.Error));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Req.ActorId);
    // Read back from the actor, and name what was actually written — the old
    // reply could not be told apart from one where nothing applied.
    TArray<TSharedPtr<FJsonValue>> Applied;
    for (const FString& K : Res.AppliedKeys) Applied.Add(MakeShared<FJsonValueString>(K));
    Out->SetArrayField(TEXT("applied"), Applied);
    Out->SetObjectField(TEXT("location"), VecToJson(Res.Location));
    Out->SetObjectField(TEXT("rotation"), RotToJson(Res.Rotation));
    Out->SetObjectField(TEXT("scale"),    VecToJson(Res.Scale));
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_list
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::List(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("actor_list: no editor world"));

    FString ClassFilter, TagFilter;
    P->TryGetStringField(TEXT("class_filter"), ClassFilter);
    P->TryGetStringField(TEXT("tag"), TagFilter);

    // Opt-in flag to include Hayba internal plumbing actors (capture rig, etc.).
    // Default false — most callers don't want to see them.
    bool bIncludeInternal = false;
    P->TryGetBoolField(TEXT("include_internal"), bIncludeInternal);

    TArray<TSharedPtr<FJsonValue>> Actors;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        AActor* Actor = *It;
        if (!Actor) continue;

        // Skip internal Hayba plumbing unless explicitly requested.
        if (!bIncludeInternal && (Actor->ActorHasTag(TEXT("HaybaMCPCaptureActor")) || Actor->ActorHasTag(TEXT("HaybaMCP_Internal"))))
        {
            continue;
        }

        // Class filter
        if (!ClassFilter.IsEmpty() && Actor->GetClass()->GetName() != ClassFilter)
            continue;

        // Tag filter
        if (!TagFilter.IsEmpty() && !Actor->ActorHasTag(FName(*TagFilter)))
            continue;

        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("id"),    Actor->GetName());
        Entry->SetStringField(TEXT("label"), Actor->GetActorLabel());
        Entry->SetStringField(TEXT("class"), Actor->GetClass()->GetName());
        Entry->SetObjectField(TEXT("location"), VecToJson(Actor->GetActorLocation()));
        Actors.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));

        if (Actors.Num() >= 500) break;
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("actors"), Actors);
    Out->SetNumberField(TEXT("count"), Actors.Num());
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_get_properties
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::GetProps(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_get_properties: missing actor_id"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_get_properties: actor not found: %s"), *ActorId));

    TSharedPtr<FJsonObject> Props = MakeShared<FJsonObject>();
    for (TFieldIterator<FProperty> PropIt(Actor->GetClass(), EFieldIterationFlags::IncludeSuper); PropIt; ++PropIt)
    {
        FProperty* Prop = *PropIt;
        if (!Prop->HasAnyPropertyFlags(CPF_Edit)) continue;

        FString Value;
        Prop->ExportTextItem_Direct(Value, Prop->ContainerPtrToValuePtr<void>(Actor), nullptr, nullptr, PPF_None);
        Props->SetStringField(Prop->GetName(), Value);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"),   ActorId);
    Out->SetObjectField(TEXT("properties"), Props);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_set_properties
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::SetProps(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_set_properties: missing actor_id"));

    const TSharedPtr<FJsonObject>* PropsObj;
    if (!P->TryGetObjectField(TEXT("properties"), PropsObj) || !PropsObj->IsValid())
        return FHaybaHandlerResult::Err(TEXT("actor_set_properties: missing properties"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_set_properties: actor not found: %s"), *ActorId));

    TArray<TSharedPtr<FJsonValue>> SetNames;
    // Honesty: track properties we could NOT apply (unknown/non-editable/bad
    // value) instead of silently dropping them and still reporting success.
    TArray<TSharedPtr<FJsonValue>> Skipped;
    const int32 Requested = (*PropsObj)->Values.Num();
    for (const auto& Pair : (*PropsObj)->Values)
    {
        FProperty* Prop = Actor->GetClass()->FindPropertyByName(FName(*Pair.Key));
        if (!Prop || !Prop->HasAnyPropertyFlags(CPF_Edit))
        {
            Skipped.Add(MakeShared<FJsonValueString>(FString::Printf(
                TEXT("%s (unknown or non-editable)"), *Pair.Key)));
            continue;
        }

        // Routed through the shared reflection module rather than a local
        // stringify-then-ImportText pass. The old path coerced JSON to text and
        // handed it to ImportText_Direct, which meant a JSON object or array
        // was rejected as "unsupported value type" — so
        // {"RelativeLocation": {"X":1,"Y":2,"Z":3}} failed on an actor while the
        // identical shape worked on a widget, purely because the two handlers
        // had different copies of this loop. SetValueFromJson still routes a
        // STRING for a struct through ImportText, so nothing that worked before
        // stops working.
        if (!HaybaReflection::SetValueFromJson(Prop, Actor, Pair.Value, Actor))
        {
            Skipped.Add(MakeShared<FJsonValueString>(FString::Printf(
                TEXT("%s (value could not be applied to %s)"), *Pair.Key, *Prop->GetCPPType())));
            continue;
        }
        SetNames.Add(MakeShared<FJsonValueString>(FString(*Pair.Key)));
    }

    // If the caller requested properties but none applied, that is a failure.
    if (Requested > 0 && SetNames.Num() == 0)
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("actor_set_properties: no properties applied on %s (%d requested, all skipped)"),
            *ActorId, Requested));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetArrayField(TEXT("set"), SetNames);
    Out->SetNumberField(TEXT("set_count"), SetNames.Num());
    Out->SetArrayField(TEXT("skipped"), Skipped);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_tag
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::Tag(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_tag: missing actor_id"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_tag: actor not found: %s"), *ActorId));

    const TArray<TSharedPtr<FJsonValue>>* AddArr;
    if (P->TryGetArrayField(TEXT("add"), AddArr))
    {
        for (const auto& V : *AddArr)
            Actor->Tags.AddUnique(FName(*V->AsString()));
    }

    const TArray<TSharedPtr<FJsonValue>>* RemoveArr;
    if (P->TryGetArrayField(TEXT("remove"), RemoveArr))
    {
        for (const auto& V : *RemoveArr)
            Actor->Tags.Remove(FName(*V->AsString()));
    }

    TArray<TSharedPtr<FJsonValue>> TagList;
    for (const FName& T : Actor->Tags)
        TagList.Add(MakeShared<FJsonValueString>(T.ToString()));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetArrayField(TEXT("tags"), TagList);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_snap_to_socket
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::SnapToSocket(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId, TargetId, SocketName;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_snap_to_socket: missing actor_id"));
    if (!P->TryGetStringField(TEXT("target_actor_id"), TargetId))
        return FHaybaHandlerResult::Err(TEXT("actor_snap_to_socket: missing target_actor_id"));
    if (!P->TryGetStringField(TEXT("socket_name"), SocketName))
        return FHaybaHandlerResult::Err(TEXT("actor_snap_to_socket: missing socket_name"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor  = FindActorByName(World, ActorId);
    AActor* Target = FindActorByName(World, TargetId);
    if (!Actor)  return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_snap_to_socket: actor not found: %s"), *ActorId));
    if (!Target) return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_snap_to_socket: target not found: %s"), *TargetId));

    // Find first skeletal or static mesh component on target
    USceneComponent* SocketComp = nullptr;
    if (USkeletalMeshComponent* SKM = Target->FindComponentByClass<USkeletalMeshComponent>())
        SocketComp = SKM;
    else if (UStaticMeshComponent* SM = Target->FindComponentByClass<UStaticMeshComponent>())
        SocketComp = SM;

    if (!SocketComp)
        return FHaybaHandlerResult::Err(TEXT("actor_snap_to_socket: target has no SkeletalMesh or StaticMesh component"));

    if (SocketComp && !SocketComp->DoesSocketExist(FName(*SocketName)))
        return FHaybaHandlerResult::Err(FString::Printf(
            TEXT("actor_snap_to_socket: socket '%s' does not exist on target actor"), *SocketName));

    Actor->AttachToComponent(SocketComp,
        FAttachmentTransformRules::SnapToTargetNotIncludingScale,
        FName(*SocketName));

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"),    ActorId);
    Out->SetStringField(TEXT("attached_to"), TargetId);
    Out->SetStringField(TEXT("socket"),      SocketName);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_duplicate
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::Duplicate(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_duplicate: missing actor_id"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_duplicate: actor not found: %s"), *ActorId));

    UEditorActorSubsystem* EAS = GEditor ? GEditor->GetEditorSubsystem<UEditorActorSubsystem>() : nullptr;
    if (!EAS) return FHaybaHandlerResult::Err(TEXT("actor_duplicate: EditorActorSubsystem unavailable"));

    FVector Offset = FVector(0, 0, 100);
    const TArray<TSharedPtr<FJsonValue>>* OffArr;
    if (P->TryGetArrayField(TEXT("offset"), OffArr))
        Offset = ParseVec3(*OffArr, Offset);

    AActor* NewActor = EAS->DuplicateActor(Actor);
    if (!NewActor)
        return FHaybaHandlerResult::Err(TEXT("actor_duplicate: DuplicateActor failed"));

    NewActor->SetActorLocation(Actor->GetActorLocation() + Offset);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("new_actor_id"), NewActor->GetName());
    Out->SetStringField(TEXT("label"),        NewActor->GetActorLabel());
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_set_visibility
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::SetVisibility(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_set_visibility: missing actor_id"));

    bool bVisible = true;
    P->TryGetBoolField(TEXT("visible"), bVisible);

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_set_visibility: actor not found: %s"), *ActorId));

    Actor->SetActorHiddenInGame(!bVisible);
    Actor->SetIsTemporarilyHiddenInEditor(!bVisible);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetBoolField(TEXT("visible"), bVisible);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_get_components
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::GetComponents(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("actor_get_components: missing actor_id"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_get_components: actor not found: %s"), *ActorId));

    TArray<UActorComponent*> Comps;
    Actor->GetComponents(Comps);

    TArray<TSharedPtr<FJsonValue>> CompList;
    for (UActorComponent* Comp : Comps)
    {
        if (!Comp) continue;
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("name"),  Comp->GetName());
        Entry->SetStringField(TEXT("class"), Comp->GetClass()->GetName());
        CompList.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"),   ActorId);
    Out->SetArrayField(TEXT("components"),  CompList);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_call_function
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::CallFunction(const TSharedPtr<FJsonObject>& P)
{
    FString ActorId, FuncName;
    if (!P->TryGetStringField(TEXT("actor_id"),      ActorId))   return FHaybaHandlerResult::Err(TEXT("actor_call_function: missing actor_id"));
    if (!P->TryGetStringField(TEXT("function_name"), FuncName))  return FHaybaHandlerResult::Err(TEXT("actor_call_function: missing function_name"));

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_call_function: actor not found: %s"), *ActorId));

    UFunction* Func = Actor->FindFunction(FName(*FuncName));
    if (!Func)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_call_function: function not found: %s"), *FuncName));

    if (!Func->HasAnyFunctionFlags(FUNC_BlueprintCallable))
        return FHaybaHandlerResult::Err(TEXT("actor_call_function: function is not BlueprintCallable"));
    if (Func->ParmsSize > 0)
        return FHaybaHandlerResult::Err(TEXT("actor_call_function: parameterised functions not yet supported — use actor_set_properties instead"));
    Actor->ProcessEvent(Func, nullptr);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), ActorId);
    Out->SetStringField(TEXT("function"), FuncName);
    Out->SetBoolField(TEXT("called"),     true);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// actor_batch_spawn
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::BatchSpawn(const TSharedPtr<FJsonObject>& P)
{
    const TArray<TSharedPtr<FJsonValue>>* ActorsArr;
    if (!P->TryGetArrayField(TEXT("actors"), ActorsArr))
        return FHaybaHandlerResult::Err(TEXT("actor_batch_spawn: missing actors array"));

    const int32 MaxBatch = 100;
    if (ActorsArr->Num() > MaxBatch)
        return FHaybaHandlerResult::Err(FString::Printf(TEXT("actor_batch_spawn: batch size %d exceeds limit of %d"), ActorsArr->Num(), MaxBatch));

    TArray<TSharedPtr<FJsonValue>> Spawned;
    TArray<TSharedPtr<FJsonValue>> Errors;

    for (const auto& Val : *ActorsArr)
    {
        TSharedPtr<FJsonObject> SpawnParams = Val->AsObject();
        if (!SpawnParams.IsValid())
        {
            Errors.Add(MakeShared<FJsonValueString>(TEXT("invalid spawn param object")));
            continue;
        }

        FHaybaHandlerResult R = Spawn(SpawnParams);
        if (R.bOk)
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            FString Id, Label;
            R.Data->TryGetStringField(TEXT("actor_id"), Id);
            R.Data->TryGetStringField(TEXT("label"),    Label);
            Entry->SetStringField(TEXT("actor_id"), Id);
            Entry->SetStringField(TEXT("label"),    Label);
            Spawned.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
        }
        else
        {
            Errors.Add(MakeShared<FJsonValueString>(R.ErrorMessage));
        }
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetArrayField(TEXT("spawned"), Spawned);
    Out->SetArrayField(TEXT("errors"),  Errors);
    return FHaybaHandlerResult::Ok(Out);
}

// ---------------------------------------------------------------------------
// placement_validate
// ---------------------------------------------------------------------------
FHaybaHandlerResult FHaybaMCPActorHandler::ValidatePlacement(const TSharedPtr<FJsonObject>& P)
{
    FString ClassPath;
    if (!P->TryGetStringField(TEXT("class_path"), ClassPath))
        return FHaybaHandlerResult::Err(TEXT("placement_validate: missing class_path"));

    const TArray<TSharedPtr<FJsonValue>>* LocArr;
    if (!P->TryGetArrayField(TEXT("location"), LocArr))
        return FHaybaHandlerResult::Err(TEXT("placement_validate: missing location"));

    FVector Location = ParseVec3(*LocArr);

    double RadiusDbl = 50.0;
    P->TryGetNumberField(TEXT("radius"), RadiusDbl);
    float Radius = static_cast<float>(RadiusDbl);

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
        return FHaybaHandlerResult::Err(TEXT("placement_validate: no editor world"));

    FCollisionObjectQueryParams ObjParams(FCollisionObjectQueryParams::AllObjects);
    FCollisionShape Sphere = FCollisionShape::MakeSphere(Radius);

    TArray<FOverlapResult> Overlaps;
    World->OverlapMultiByObjectType(Overlaps, Location, FQuat::Identity, ObjParams, Sphere);

    TArray<TSharedPtr<FJsonValue>> OverlapList;
    for (const FOverlapResult& Ov : Overlaps)
    {
        AActor* OvActor = Ov.GetActor();
        if (!OvActor) continue;
        TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("id"),    OvActor->GetName());
        Entry->SetStringField(TEXT("class"), OvActor->GetClass()->GetName());
        OverlapList.Add(MakeShared<FJsonValueObject>(Entry.ToSharedRef()));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("valid"),      Overlaps.Num() == 0);
    Out->SetArrayField(TEXT("overlaps"),  OverlapList);
    return FHaybaHandlerResult::Ok(Out);
}
