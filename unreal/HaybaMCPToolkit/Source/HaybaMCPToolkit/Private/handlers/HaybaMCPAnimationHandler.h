#pragma once
#include "IHaybaMCPHandler.h"

class UAnimBlueprint;
class UAnimStateMachineGraph;
class UAnimStateNodeBase;
class UAnimStateNode;
class UAnimStateTransitionNode;

class FHaybaMCPAnimationHandler : public IHaybaMCPHandler
{
public:
    virtual FString GetDomain() const override { return TEXT("anim"); }
    virtual TArray<FString> GetCommands() const override;
    virtual FHaybaHandlerResult Handle(const FString& Cmd, const TSharedPtr<FJsonObject>& Params) override;

private:
    FHaybaHandlerResult GetInfo(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddState(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult AddTransition(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult SetCondition(const TSharedPtr<FJsonObject>& P);
    FHaybaHandlerResult Compile(const TSharedPtr<FJsonObject>& P);
};
