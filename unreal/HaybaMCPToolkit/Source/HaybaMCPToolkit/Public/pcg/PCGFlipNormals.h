// Generic mesh primitive: reverse a dynamic mesh's winding + normals (e.g. to render
// a swept shell single-sided from the inside).
#pragma once

#include "PCGSettings.h"
#include "PCGFlipNormals.generated.h"

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGFlipNormalsSettings : public UPCGSettings
{
    GENERATED_BODY()
public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return FName(TEXT("FlipNormals")); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override;
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
    virtual FPCGElementPtr CreateElement() const override;
};

class FPCGFlipNormalsElement : public IPCGElement
{
protected:
    virtual bool ExecuteInternal(FPCGContext* InContext) const override;
    virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
