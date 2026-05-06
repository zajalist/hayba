#pragma once
#include "IHaybaMCPHandler.h"
#include "GameFramework/Actor.h"

class FHaybaMCPSceneGraphHandler : public IHaybaMCPHandler
{
public:
    enum class EMode { Flat, Relational, Hierarchical };

    virtual FString GetDomain() const override { return TEXT("scene"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult Export(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult ValidatePhysics(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult GetActorRelations(const TSharedPtr<FJsonObject>& P);

    static EMode ParseMode(const FString& S);
    static FBox ParseWindow(const TSharedPtr<FJsonObject>& P);
    static TArray<AActor*> CollectInWindow(UWorld* W, const FBox& Box, int32 MaxItems);
    static TSharedRef<FJsonObject> ActorToFlatJson(AActor* A);
    static TSharedRef<FJsonObject> BuildFlat(const TArray<AActor*>& Actors);
    static TSharedRef<FJsonObject> BuildRelational(const TArray<AActor*>& Actors);
    static TSharedRef<FJsonObject> BuildHierarchical(const TArray<AActor*>& Actors);
    static FString ClassifyActor(AActor* A);
    static void WriteCognitiveMapCache(const TSharedRef<FJsonObject>& Data);
};
