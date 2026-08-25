// SRecipeParamEnum.h
#pragma once
#include "Recipes/SRecipeParamWidget.h"
#include "Widgets/Input/SComboBox.h"

class SRecipeParamEnum : public SRecipeParamWidget
{
public:
    SLATE_BEGIN_ARGS(SRecipeParamEnum) {}
        SLATE_ARGUMENT(FHaybaRecipeParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    TArray<TSharedPtr<FString>> Options;
    TSharedPtr<FString> Selected;
};
