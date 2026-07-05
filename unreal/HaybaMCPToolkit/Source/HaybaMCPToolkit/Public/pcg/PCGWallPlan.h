// Plumb | Wall Plan — thin PCG wrapper over FPlumbWallPlanner (the pure resolution core).
// Decides sockets/segments; realization stays in graphs (spec 2026-07-05, grill Q7:
// pins-only inputs => cacheable, multithread-safe pure math).

#pragma once

#include "PCGSettings.h"
#include "PCGWallPlan.generated.h"

UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGWallPlanSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return FName(TEXT("WallPlan")); }
	virtual FText GetDefaultNodeTitle() const override;
	virtual FText GetNodeTooltipText() const override;
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::Spatial; }
#endif

	/** Corner angle (deg): bends sharper than this split the wall into separate straight runs. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Plan, meta = (ClampMin = "1", ClampMax = "89"))
	double CornerAngleDeg = 30.0;

	/** Minimum shared span (cm) for a junction to produce a socket. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Plan, meta = (ClampMin = "10"))
	double MinOverlap = 150.0;

	/** Wall thickness (cm) — also the mouth-coincidence tolerance base. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Plan, meta = (ClampMin = "1"))
	double WallThickness = 30.0;

	/** Corridor width (cm) for open splines (v1 uniform; per-actor override later). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Plan, meta = (ClampMin = "50"))
	double CorridorWidth = 300.0;

	/** Wall height (cm). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Plan, meta = (ClampMin = "50"))
	double WallHeight = 300.0;

	/** Default entrance opening (cm) when no DA_SocketType is declared. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Sockets, meta = (ClampMin = "50"))
	double DefaultOpeningWidth = 150.0;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Sockets, meta = (ClampMin = "50"))
	double DefaultOpeningHeight = 220.0;

protected:
	virtual TArray<FPCGPinProperties> InputPinProperties() const override;
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
	virtual FPCGElementPtr CreateElement() const override;
};

class FPCGWallPlanElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* InContext) const override;
	// Pure function of pin data + settings (Q7): cacheable.
	virtual bool IsCacheable(const UPCGSettings*) const override { return true; }
};
