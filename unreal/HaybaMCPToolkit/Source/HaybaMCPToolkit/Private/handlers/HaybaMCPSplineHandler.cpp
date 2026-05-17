#include "HaybaMCPSplineHandler.h"
#include "Json.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Components/SplineComponent.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPSpline, Log, All);

namespace
{
    static UWorld* EditorWorld()
    {
        return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    }

    static bool ReadVec(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, FVector& Out)
    {
        const TArray<TSharedPtr<FJsonValue>>* Arr;
        if (!Obj.IsValid() || !Obj->TryGetArrayField(Field, Arr) || Arr->Num() < 3) return false;
        Out = FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
        return true;
    }

    static AActor* FindActorByName(UWorld* World, const FString& Name)
    {
        if (!World) return nullptr;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            if (It->GetName() == Name || It->GetActorLabel() == Name)
                return *It;
        }
        return nullptr;
    }

    static USplineComponent* GetSpline(AActor* Actor)
    {
        if (!Actor) return nullptr;
        return Actor->FindComponentByClass<USplineComponent>();
    }

    static TSharedPtr<FJsonObject> VecToJson(const FVector& V)
    {
        TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
        Obj->SetNumberField(TEXT("x"), V.X);
        Obj->SetNumberField(TEXT("y"), V.Y);
        Obj->SetNumberField(TEXT("z"), V.Z);
        return Obj;
    }
}

TArray<FString> FHaybaMCPSplineHandler::GetCommands() const
{
    return {
        TEXT("spline_create"),
        TEXT("spline_add_point"),
        TEXT("spline_set_point"),
        TEXT("spline_remove_point"),
        TEXT("spline_get_info"),
    };
}

FHaybaHandlerResult FHaybaMCPSplineHandler::Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& P)
{
    if (Cmd == TEXT("spline_create"))       return SplineCreate(P);
    if (Cmd == TEXT("spline_add_point"))    return SplineAddPoint(P);
    if (Cmd == TEXT("spline_set_point"))    return SplineSetPoint(P);
    if (Cmd == TEXT("spline_remove_point")) return SplineRemovePoint(P);
    if (Cmd == TEXT("spline_get_info"))     return SplineGetInfo(P);
    return FHaybaHandlerResult::Err(FString::Printf(TEXT("SplineHandler: unknown command %s"), *Cmd));
}

FHaybaHandlerResult FHaybaMCPSplineHandler::SplineCreate(const TSharedPtr<FJsonObject>& P)
{
    if (!GEditor) return FHaybaHandlerResult::Err(TEXT("spline_create: GEditor is null"));
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("spline_create: no editor world"));

    FString Label;
    if (!P->TryGetStringField(TEXT("label"), Label) || Label.IsEmpty())
        return FHaybaHandlerResult::Err(TEXT("spline_create: missing label"));

    FVector Loc = FVector::ZeroVector;
    ReadVec(P, TEXT("location"), Loc);

    FActorSpawnParameters Sp;
    Sp.Name = MakeUniqueObjectName(World->GetCurrentLevel(), AActor::StaticClass(), FName(*Label));
    AActor* Actor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform(Loc), Sp);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("spline_create: SpawnActor failed"));

    USplineComponent* Spline = NewObject<USplineComponent>(Actor, USplineComponent::StaticClass(), TEXT("Spline"));
    Actor->SetRootComponent(Spline);
    Spline->RegisterComponent();
    Actor->AddInstanceComponent(Spline);
    Actor->SetActorLabel(Label);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetStringField(TEXT("actor_id"), Actor->GetName());
    Out->SetStringField(TEXT("label"), Actor->GetActorLabel());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSplineHandler::SplineAddPoint(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("spline_add_point: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("spline_add_point: missing actor_id"));

    FVector Loc;
    if (!ReadVec(P, TEXT("location"), Loc))
        return FHaybaHandlerResult::Err(TEXT("spline_add_point: missing location"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("spline_add_point: actor not found"));
    USplineComponent* Spline = GetSpline(Actor);
    if (!Spline) return FHaybaHandlerResult::Err(TEXT("spline_add_point: no spline component"));

    int32 Index = -1;
    if (P->TryGetNumberField(TEXT("index"), Index) && Index >= 0)
    {
        Spline->AddSplinePointAtIndex(Loc, Index, ESplineCoordinateSpace::World, true);
    }
    else
    {
        Spline->AddSplinePoint(Loc, ESplineCoordinateSpace::World, true);
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("point_count"), Spline->GetNumberOfSplinePoints());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSplineHandler::SplineSetPoint(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("spline_set_point: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("spline_set_point: missing actor_id"));

    int32 Index = 0;
    if (!P->TryGetNumberField(TEXT("index"), Index))
        return FHaybaHandlerResult::Err(TEXT("spline_set_point: missing index"));

    FVector Loc;
    if (!ReadVec(P, TEXT("location"), Loc))
        return FHaybaHandlerResult::Err(TEXT("spline_set_point: missing location"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("spline_set_point: actor not found"));
    USplineComponent* Spline = GetSpline(Actor);
    if (!Spline) return FHaybaHandlerResult::Err(TEXT("spline_set_point: no spline component"));

    Spline->SetLocationAtSplinePoint(Index, Loc, ESplineCoordinateSpace::World, true);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetBoolField(TEXT("updated"), true);
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSplineHandler::SplineRemovePoint(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("spline_remove_point: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("spline_remove_point: missing actor_id"));

    int32 Index = 0;
    if (!P->TryGetNumberField(TEXT("index"), Index))
        return FHaybaHandlerResult::Err(TEXT("spline_remove_point: missing index"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("spline_remove_point: actor not found"));
    USplineComponent* Spline = GetSpline(Actor);
    if (!Spline) return FHaybaHandlerResult::Err(TEXT("spline_remove_point: no spline component"));

    Spline->RemoveSplinePoint(Index, true);

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("point_count"), Spline->GetNumberOfSplinePoints());
    return FHaybaHandlerResult::Ok(Out);
}

FHaybaHandlerResult FHaybaMCPSplineHandler::SplineGetInfo(const TSharedPtr<FJsonObject>& P)
{
    UWorld* World = EditorWorld();
    if (!World) return FHaybaHandlerResult::Err(TEXT("spline_get_info: no editor world"));

    FString ActorId;
    if (!P->TryGetStringField(TEXT("actor_id"), ActorId))
        return FHaybaHandlerResult::Err(TEXT("spline_get_info: missing actor_id"));

    AActor* Actor = FindActorByName(World, ActorId);
    if (!Actor) return FHaybaHandlerResult::Err(TEXT("spline_get_info: actor not found"));
    USplineComponent* Spline = GetSpline(Actor);
    if (!Spline) return FHaybaHandlerResult::Err(TEXT("spline_get_info: no spline component"));

    int32 Count = Spline->GetNumberOfSplinePoints();
    TArray<TSharedPtr<FJsonValue>> Points;
    for (int32 i = 0; i < Count; ++i)
    {
        FVector Loc = Spline->GetLocationAtSplinePoint(i, ESplineCoordinateSpace::World);
        FVector Tan = Spline->GetTangentAtSplinePoint(i, ESplineCoordinateSpace::World);
        TSharedPtr<FJsonObject> Pt = MakeShared<FJsonObject>();
        Pt->SetObjectField(TEXT("location"), VecToJson(Loc));
        Pt->SetObjectField(TEXT("tangent"), VecToJson(Tan));
        Points.Add(MakeShared<FJsonValueObject>(Pt));
    }

    TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
    Out->SetNumberField(TEXT("point_count"), Count);
    Out->SetNumberField(TEXT("length"), Spline->GetSplineLength());
    Out->SetArrayField(TEXT("points"), Points);
    return FHaybaHandlerResult::Ok(Out);
}
