// SRecipeParamFloat.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"

class SRecipeParamFloat : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamFloat) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    float Value = 0.f;
};
