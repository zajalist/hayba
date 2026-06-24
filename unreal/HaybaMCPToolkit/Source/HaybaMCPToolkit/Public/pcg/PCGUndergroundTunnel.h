// Underground tunnel PCG node — sweeps ONE continuous (seamless) dynamic mesh
// tunnel shell along the input spline. Unlike spline-mesh tiling, this is a
// single welded mesh: no segment joints, no seams. Inner-wall only (the player
// is always inside), single-sided winding for economy.

#pragma once

#include "PCGSettings.h"
#include "PCGUndergroundTunnel.generated.h"

/**
 * Generate a seamless tunnel shell (single dynamic mesh) from a spline.
 */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGUndergroundTunnelSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return FName(TEXT("UndergroundTunnel")); }
	virtual FText GetDefaultNodeTitle() const override;
	virtual FText GetNodeTooltipText() const override;
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::DynamicMesh; }
#endif

	/** Bore width (cm). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Tunnel, meta = (ClampMin = "50"))
	float Width = 600.f;

	/** Bore height (cm). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Tunnel, meta = (ClampMin = "50"))
	float Height = 400.f;

	/** Ring spacing along the spline (cm) — smaller = smoother curve. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Tunnel, meta = (ClampMin = "10"))
	float SampleSpacing = 60.f;

	/** Material applied to the generated shell. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Tunnel)
	TSoftObjectPtr<UMaterialInterface> Material;

protected:
	virtual TArray<FPCGPinProperties> InputPinProperties() const override;
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
	virtual FPCGElementPtr CreateElement() const override;
};

class FPCGUndergroundTunnelElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* InContext) const override;
	// Building geometry — never cache.
	virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
