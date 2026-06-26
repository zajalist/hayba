// Generic mesh primitive: world-space box (tri-planar) UV projection. Gives swept/
// bonded shells a clean grid-aligned UV so tiling grid materials map correctly
// (the sweep + boolean ops don't author usable UVs themselves).
#pragma once

#include "PCGSettings.h"
#include "PCGBoxUV.generated.h"

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGBoxUVSettings : public UPCGSettings
{
    GENERATED_BODY()
public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return FName(TEXT("BoxUV")); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

    /** World size (cm) that maps to one UV tile — smaller = denser grid. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = UV, meta = (ClampMin = "1"))
    double TileSizeCm = 256.0;

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override;
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
    virtual FPCGElementPtr CreateElement() const override;
};

class FPCGBoxUVElement : public IPCGElement
{
protected:
    virtual bool ExecuteInternal(FPCGContext* InContext) const override;
    virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
