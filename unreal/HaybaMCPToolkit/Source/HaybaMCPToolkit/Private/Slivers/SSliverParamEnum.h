// SSliverParamEnum.h
#pragma once
#include "Slivers/SSliverParamWidget.h"
#include "Widgets/Input/SComboBox.h"

class SSliverParamEnum : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamEnum) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    TArray<TSharedPtr<FString>> Options;
    TSharedPtr<FString> Selected;
};
