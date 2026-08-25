// SRecipeParamBool.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"

class SRecipeParamBool : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamBool) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    bool bValue = false;
};
