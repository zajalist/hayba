// SSliverParamBool.h
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamBool : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamBool) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;
private:
    bool bValue = false;
};
