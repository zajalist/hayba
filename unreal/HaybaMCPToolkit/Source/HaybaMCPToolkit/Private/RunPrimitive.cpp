#include "RunPrimitive.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(RunPrimitive)

ARunPrimitive::ARunPrimitive()
{
	// Actor does not need per-frame tick.
	PrimaryActorTick.bCanEverTick = false;

	// ---- Root component ----
	RootSceneComponent = CreateDefaultSubobject<USceneComponent>(TEXT("RootSceneComponent"));
	SetRootComponent(RootSceneComponent);

	// ---- Spline (tunnel centreline) ----
	SplineComponent = CreateDefaultSubobject<USplineComponent>(TEXT("SplineComponent"));
	SplineComponent->SetupAttachment(RootSceneComponent);

	// ---- Box (room AABB) ----
	BoxComponent = CreateDefaultSubobject<UBoxComponent>(TEXT("BoxComponent"));
	BoxComponent->SetupAttachment(RootSceneComponent);
	// Default half-extents: W/2 x W/2 x H/2 in cm (W=1.8m, H=2.4m).
	BoxComponent->SetBoxExtent(FVector(W * 0.5 * 100.0, W * 0.5 * 100.0, H * 0.5 * 100.0));

	// ---- Tag ----
	Tags.Add(FName(TEXT("hayba.primitive")));
}
