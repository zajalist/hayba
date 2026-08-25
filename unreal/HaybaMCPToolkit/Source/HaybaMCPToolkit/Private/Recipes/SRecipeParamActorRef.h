// SRecipeParamActorRef.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"

/** Fires when the user picks an actor — carries the actor's world location
 *  so the detail panel can auto-fill a sibling vector3 param. */
DECLARE_DELEGATE_OneParam(FOnRecipeActorPicked, const FVector& /*WorldLocation*/);

class SRecipeParamActorRef : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamActorRef) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;

    /** Bound by SRecipeDetailPanel to mirror the picked actor's location
     *  into a sibling "<id>_location" vector3 widget. */
    FOnRecipeActorPicked OnActorPicked;

private:
    FString Value;
    FReply OnPickFromSelection();
};
