// SSliverParamFloat.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamFloat : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamFloat) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    float Value = 0.f;
};
