// SSliverParamActorRef.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

/** Fires when the user picks an actor — carries the actor's world location
 *  so the detail panel can auto-fill a sibling vector3 param. */
DECLARE_DELEGATE_OneParam(FOnSliverActorPicked, const FVector& /*WorldLocation*/);

class SSliverParamActorRef : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamActorRef) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;

    /** Bound by SSliverDetailPanel to mirror the picked actor's location
     *  into a sibling "<id>_location" vector3 widget. */
    FOnSliverActorPicked OnActorPicked;

private:
    FString Value;
    FReply OnPickFromSelection();
};
