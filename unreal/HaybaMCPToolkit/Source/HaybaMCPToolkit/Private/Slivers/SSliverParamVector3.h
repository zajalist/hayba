// SSliverParamVector3.h — three labelled X/Y/Z spin boxes for a vector3
// param. The detail panel can auto-fill it from a picked actor's world
// location via SetVector().
#pragma once
#include "Slivers/SSliverParamWidget.h"

class SSliverParamVector3 : public SSliverParamWidget
{
public:
    SLATE_BEGIN_ARGS(SSliverParamVector3) {}
        SLATE_ARGUMENT(FHaybaSliverParam, Param)
    SLATE_END_ARGS()
    void Construct(const FArguments& InArgs);
    virtual FString GetValueAsJson() const override;

    /** Overwrite all three components (used to mirror a picked actor). */
    void SetVector(const FVector& V);

private:
    double X = 0.0, Y = 0.0, Z = 0.0;
};
