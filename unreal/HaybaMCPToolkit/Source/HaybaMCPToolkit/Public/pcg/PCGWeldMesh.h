// Generic mesh primitive: weld coincident edges + recompute normals (finalize a mesh
// assembled from separate-but-touching pieces into one watertight surface).
#pragma once

#include "PCGSettings.h"
#include "PCGWeldMesh.generated.h"

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGWeldMeshSettings : public UPCGSettings
{
    GENERATED_BODY()
public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return FName(TEXT("WeldMesh")); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override;
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
    virtual FPCGElementPtr CreateElement() const override;
};

class FPCGWeldMeshElement : public IPCGElement
{
protected:
    virtual bool ExecuteInternal(FPCGContext* InContext) const override;
    virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
