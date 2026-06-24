// ARunPrimitive — authoring actor that represents a single authored primitive
// (tunnel or room) in the Hayba underground generator. Actors of this class are
// picked up by PCGTopologyConnect, which gathers them all and feeds their
// per-primitive attributes (builder, phase, seed, w, h, importance) as PCG
// metadata into the PCGGrammarSolver.
//
// NOTE: this class has NO PCG dependency — it is a plain AActor.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Components/SplineComponent.h"
#include "Components/BoxComponent.h"

#include "RunPrimitive.generated.h"

// Discriminates the primitive archetype. The PCGGrammarSolver determines kind
// from the PCG data TYPE emitted by the collector (point => Room, spline => Tunnel),
// so this enum drives which component is used, not a written attribute.
UENUM(BlueprintType)
enum class ERunPrimitiveKind : uint8
{
	Tunnel  UMETA(DisplayName = "Tunnel"),
	Room    UMETA(DisplayName = "Room"),
};

/**
 * Placed by a level designer to author a primitive (tunnel or room) for the
 * Hayba underground PCG grammar. PCGTopologyConnect iterates all ARunPrimitive
 * actors in the world and emits per-primitive PCG data carrying the fields below.
 *
 * Tunnel: the SplineComponent defines the centreline; Room: the BoxComponent
 * defines the AABB extent. Resize the box/spline in the Details panel.
 */
UCLASS(BlueprintType, ClassGroup = (HaybaUnderground), meta = (DisplayName = "Run Primitive"))
class HAYBAMCPTOOLKIT_API ARunPrimitive : public AActor
{
	GENERATED_BODY()

public:
	ARunPrimitive();

	// -----------------------------------------------------------------------
	// Components

	/** Root transform (actor pivot). */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<USceneComponent> RootSceneComponent;

	/** Spline centreline — used when Kind == Tunnel. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<USplineComponent> SplineComponent;

	/** Box volume — used when Kind == Room. Resize to set room AABB. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")
	TObjectPtr<UBoxComponent> BoxComponent;

	// -----------------------------------------------------------------------
	// Primitive type

	/** Primitive archetype: Tunnel (uses spline) or Room (uses box). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive")
	ERunPrimitiveKind Kind = ERunPrimitiveKind::Room;

	// -----------------------------------------------------------------------
	// Grammar attributes written as PCG metadata

	/** Builder tag read by the grammar's when-clause (e.g. "native" or "imperial"). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive")
	FName Builder = FName(TEXT("native"));

	/** Construction phase (e.g. "I", "II"). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive")
	FString Phase = TEXT("I");

	/** Deterministic random seed for grammar expansion. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive")
	int32 Seed = 0;

	/** Bore / room width (metres). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive", meta = (ClampMin = "0.1"))
	double W = 1.8;

	/** Bore / room height (metres). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive", meta = (ClampMin = "0.1"))
	double H = 2.4;

	/** Placement importance weight passed to downstream grammar rules (0..1). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Run Primitive", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	double Importance = 0.3;
};
