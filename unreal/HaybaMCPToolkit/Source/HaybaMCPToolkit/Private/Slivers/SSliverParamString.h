// SSliverParamString.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamString : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamString) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    FString Value;
};
