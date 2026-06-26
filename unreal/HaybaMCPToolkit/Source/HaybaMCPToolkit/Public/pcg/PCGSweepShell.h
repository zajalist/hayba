// Generic profile-sweep PCG node — sweeps ONE continuous (seamless) dynamic mesh
// shell along the input spline. Unlike spline-mesh tiling, this is a
// single welded mesh: no segment joints, no seams. Inner-wall only (the player
// is always inside), single-sided winding for economy.

#pragma once

#include "PCGSettings.h"
#include "PCGSweepShell.generated.h"

/** Shape vocabulary for the swept profile. SP-1 uses Box only; Arch/Vault are reserved for SP-5. */
UENUM(BlueprintType)
enum class EHaybaProfileShape : uint8
{
	Box   UMETA(DisplayName = "Box"),
	Arch  UMETA(DisplayName = "Arch (reserved)"),
	Vault UMETA(DisplayName = "Vault (reserved)")
};

/**
 * Sweeps a profile along the input spline into a single welded inward shell.
 */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGSweepShellSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return FName(TEXT("SweepShell")); }
	virtual FText GetDefaultNodeTitle() const override;
	virtual FText GetNodeTooltipText() const override;
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

	/** Profile cross-section shape. Box = rectangular; Arch/Vault reserved for SP-5. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Shell)
	EHaybaProfileShape ProfileShape = EHaybaProfileShape::Box;

	/** Profile width (cm). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Shell, meta = (ClampMin = "50"))
	double ProfileWidthCm = 600.0;

	/** Profile height (cm). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Shell, meta = (ClampMin = "50"))
	double ProfileHeightCm = 400.0;

	/** Ring spacing along the spline (cm) — smaller = smoother curve. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Shell, meta = (ClampMin = "10"))
	double SampleSpacingCm = 60.0;

	/** Material applied to the generated shell. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Shell)
	TSoftObjectPtr<UMaterialInterface> Material;

protected:
	virtual TArray<FPCGPinProperties> InputPinProperties() const override;
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
	virtual FPCGElementPtr CreateElement() const override;
};

class FPCGSweepShellElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* InContext) const override;
	// Building geometry — never cache.
	virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
