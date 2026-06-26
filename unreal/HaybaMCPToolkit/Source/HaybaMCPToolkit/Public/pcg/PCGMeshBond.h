// Generic mesh primitive: bond N dynamic meshes — cut an opening in each wherever
// another passes through it (once, twice, N times) and merge them all into one
// connected space. Host/branch-free N-way geometry; the solver-free half of Socket Bond.
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
