// SP-1 junction node: bonds two shells by socket-contract cost-min, punches
// the opening on success, and always writes/draws the unsat-core report.
// Reads .scratch/sockets.json; always writes .scratch/unsat-core.json. Never cached.
#pragma once

#include "PCGSettings.h"
#include "PCGSocketBond.generated.h"

class UMaterialInterface;

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGSocketBondSettings : public UPCGSettings
{
    GENERATED_BODY()
public:
#if WITH_EDITOR
    virtual FName GetDefaultNodeName() const override { return FName(TEXT("SocketBond")); }
    virtual FText GetDefaultNodeTitle() const override;
    virtual FText GetNodeTooltipText() const override;
    virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

    /** Path to sockets.json. Empty => <ProjectDir>/.scratch/sockets.json. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    FString SocketsPath;

    /** Local nudge applied to the derived bond transform (cm). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    FVector BondLocalOffset = FVector::ZeroVector;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond, meta = (ClampMin = "20"))
    double DoorWidthCm = 180.0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond, meta = (ClampMin = "20"))
    double DoorHeightCm = 220.0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond, meta = (ClampMin = "10"))
    double WallDepthCm = 80.0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    TSoftObjectPtr<UMaterialInterface> ShellMaterial;

protected:
    virtual TArray<FPCGPinProperties> InputPinProperties() const override;
    virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
    virtual FPCGElementPtr CreateElement() const override;
};

class FPCGSocketBondElement : public IPCGElement
{
protected:
    virtual bool ExecuteInternal(FPCGContext* InContext) const override;
    virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
    // Reads/writes files + touches the world (DrawDebugString) — main thread only.
    virtual bool CanExecuteOnlyOnMainThread(FPCGContext*) const override { return true; }
};
