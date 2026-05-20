#pragma once
#include "IHaybaMCPHandler.h"

class FHaybaMCPActorHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("actor"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult Spawn(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Delete(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Transform(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult List(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetProps(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetProps(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Tag(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SnapToSocket(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Duplicate(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetVisibility(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetComponents(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult CallFunction(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult BatchSpawn(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ValidatePlacement(const TSharedPtr<FJsonObject>& P);

    // Helpers
    AActor* FindActorByName(UWorld* World, const FString& Name) const;
    FVector ParseVec3(const TArray<TSharedPtr<FJsonValue>>& Arr, const FVector& Default = FVector::ZeroVector) const;
    TSharedPtr<FJsonObject> VecToJson(const FVector& V) const;
    TSharedPtr<FJsonObject> RotToJson(const FRotator& R) const;
};
