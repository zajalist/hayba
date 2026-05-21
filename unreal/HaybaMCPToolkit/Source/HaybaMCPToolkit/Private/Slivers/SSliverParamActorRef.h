// SSliverParamActorRef.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamActorRef : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamActorRef) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    FString Value;
    FReply OnPickFromSelection();
};
