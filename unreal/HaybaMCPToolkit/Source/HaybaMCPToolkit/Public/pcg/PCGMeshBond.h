// Generic mesh primitive: bond two dynamic meshes — cut an opening in each wherever
// the other passes through (once, twice, or N times) and merge them into one connected
// space. The geometry half of Socket Bond, decoupled from the constraint solver.
#pragma once

#include "PCGSettings.h"
#include "PCGMeshBond.generated.h"

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGMeshBondSettings : public UPCGSettings
{
    GENERATED_BODY()
public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return FName(TEXT("MeshBond")); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override;
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
    virtual FPCGElementPtr CreateElement() const override;
};

class FPCGMeshBondElement : public IPCGElement
{
protected:
    virtual bool ExecuteInternal(FPCGContext* InContext) const override;
    virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
