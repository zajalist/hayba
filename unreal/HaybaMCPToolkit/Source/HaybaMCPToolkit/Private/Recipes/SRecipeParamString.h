// SRecipeParamString.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"

class SRecipeParamString : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamString) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    FString Value;
};
