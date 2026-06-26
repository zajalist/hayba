// SP-1 junction node: bonds two shells by socket-contract cost-min, cuts the
// openings where they cross on success, and always writes/draws the unsat-core report.
// Reads .scratch/sockets.json; always writes .scratch/unsat-core.json. Never cached.
#pragma once

#include "PCGSettings.h"
#include "PCGSocketBond.generated.h"

class UMaterialInterface;

/** How the bonded shells' shared seam is treated. Index order is kept in lockstep with
 *  HaybaOpening::ESeamStyle (cast by value). */
UENUM(BlueprintType)
enum class EHaybaSeamStyle : uint8
{
    ButtJoint UMETA(DisplayName = "Butt Joint"),
    Welded,
    Collar
};

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

    /** Local nudge applied to the unsat-core overlay position (cm). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    FVector BondLocalOffset = FVector::ZeroVector;

    /** Material applied to the bonded shell. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    TSoftObjectPtr<UMaterialInterface> ShellMaterial;

    /** How the bonded shells' shared seam is treated (ButtJoint = leave it open). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Bond)
    EHaybaSeamStyle SeamStyle = EHaybaSeamStyle::Welded;

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
