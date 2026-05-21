// SSliverParamInt.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamInt : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamInt) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    int32 Value = 0;
};
