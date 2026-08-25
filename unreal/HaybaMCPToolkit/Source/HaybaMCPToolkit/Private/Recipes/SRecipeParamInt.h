// SRecipeParamInt.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"

class SRecipeParamInt : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamInt) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    int32 Value = 0;
};
