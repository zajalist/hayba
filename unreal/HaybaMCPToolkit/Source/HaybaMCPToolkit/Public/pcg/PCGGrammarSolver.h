// Grammar-driven placement solver PCG node — reads grammar.json (the same
// on-disk contract the TS plumb store writes), expands a seed Symbol via a
// production worklist (a faithful C++ port of expandGrammar), and emits both:
//   - point data on the default "Out" pin (columns + scattered rubble), to be
//     placed by a downstream PCGStaticMeshSpawner, and
//   - a single welded inner shell (walls + a bent vent shaft) on the "Shell"
//     dynamic-mesh pin, reusing the proven UndergroundTunnel winding lambdas.
//
// Determinism: NO FMath::Rand / time. Any jitter comes from a small deterministic
// hash of (symbol-kind + index). IsCacheable=false (we build geometry).
//
// IMPORTANT (constraint scope): the full constraint/guard evaluation lives in TS.
// This node implements ONLY the two structural guards the geometry actually needs
// (clearance + max_straight_run / no_straight_air). EVERY other guard id PASSES.
// See the guard hook in the .cpp for the exact, documented behavior.

#pragma once

#include "PCGSettings.h"
#include "PCGGrammarSolver.generated.h"

class UStaticMesh;
class UMaterialInterface;

/**
 * Solve a placement grammar against the input spline, emitting placed points
 * (columns, scattered rubble) and a welded inner shell (walls + bent vent).
 */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGGrammarSolverSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return FName(TEXT("GrammarSolver")); }
	virtual FText GetDefaultNodeTitle() const override;
	virtual FText GetNodeTooltipText() const override;
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::Spawner; }
#endif

	/** Path to grammar.json. Empty => <ProjectDir>/.scratch/grammar.json. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Grammar)
	FString GrammarPath;

	/** Path to constraints.json. Present but unused in this slice (full eval is in TS). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Grammar)
	FString ConstraintsPath;

	/** Mesh used for emitted columns (written per-point as a soft-object path). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Grammar)
	TSoftObjectPtr<UStaticMesh> ColumnMesh;

	/** Mesh used for the vent (present for parity; the shell builds the vent geometry). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Grammar)
	TSoftObjectPtr<UStaticMesh> VentMesh;

	/** Material applied to the generated shell dynamic mesh. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Grammar)
	TSoftObjectPtr<UMaterialInterface> ShellMaterial;

protected:
	virtual TArray<FPCGPinProperties> InputPinProperties() const override;
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
	virtual FPCGElementPtr CreateElement() const override;
};

class FPCGGrammarSolverElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* InContext) const override;
	// Building geometry + reading a file — never cache.
	virtual bool IsCacheable(const UPCGSettings*) const override { return false; }
};
