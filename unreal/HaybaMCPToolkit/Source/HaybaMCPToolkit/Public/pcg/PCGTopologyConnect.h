// PCGTopologyConnect — collector PCG node that gathers all ARoomVolume and
// ATunnelSpline actors in the world and emits one PCG data item per primitive
// on the "Out" pin:
//   - ARoomVolume  -> UPCGBasePointData (single point)
//   - ATunnelSpline -> UPCGSplineData (from the actor's SplineComponent)
//
// Per-primitive grammar attributes (builder, phase, seed, w, h, importance,
// prim_id) are written as METADATA DEFAULT VALUES so PCGGrammarSolver's
// ReadStrAttr / ReadNumAttr helpers return them via PCGFirstEntryKey without
// needing per-entry initialization.
//
// Actor iteration is NOT thread-safe, so CanExecuteOnlyOnMainThread returns true.
// IsCacheable returns false (world-state dependent).

#pragma once

#include "PCGSettings.h"
#include "Elements/PCGActorSelector.h"
#include "PCGTopologyConnect.generated.h"

/**
 * Collects ARoomVolume and ATunnelSpline actors and emits typed PCG data for
 * the GrammarSolver.
 */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class UPCGTopologyConnectSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return FName(TEXT("TopologyConnect")); }
	virtual FText GetDefaultNodeTitle() const override;
	virtual FText GetNodeTooltipText() const override;
	// Generates spatial data (primitives) from the world; no "Generator" enum value
	// exists — Spawner is the closest (and matches PCGGrammarSolver).
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::Spawner; }

	// Live tracking: re-execute when any actor tagged "hayba.primitive" changes.
	// FLAG [UNCERTAIN]: GetStaticTrackedKeys signature — in UE 5.4+ the override is:
	//   virtual void GetStaticTrackedKeys(FPCGSelectionKeyToSettingsMap& OutKeysToSettings,
	//       TArray<TObjectPtr<const UPCGGraph>>& OutVisitedGraphs) const override;
	// and FPCGSelectionKey(FName tag) constructs a tag-based key. Verify both the
	// method signature and FPCGSelectionKey constructor in 5.7. If the tag-based
	// constructor is not available, use FPCGSelectionKey(EActorFilter::AllWorldActors)
	// as a broader fallback.
	virtual void GetStaticTrackedKeys(FPCGSelectionKeyToSettingsMap& OutKeysToSettings,
		TArray<TObjectPtr<const UPCGGraph>>& OutVisitedGraphs) const override;
#endif

protected:
	// No required input pin: this is a source / generator node.
	virtual TArray<FPCGPinProperties> InputPinProperties() const override;
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override;
	virtual FPCGElementPtr CreateElement() const override;
};

class FPCGTopologyConnectElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* InContext) const override;

	// World-state dependent — never cache.
	virtual bool IsCacheable(const UPCGSettings*) const override { return false; }

	// Actor iteration (TActorIterator) must run on the game thread.
	// FLAG [UNCERTAIN]: In UE 5.7 the virtual is declared on IPCGElement as:
	//   virtual bool CanExecuteOnlyOnMainThread(FPCGContext* Context) const
	// returning false by default. Overriding it to return true gates execution to
	// the game thread. If the signature changed in 5.7 (e.g. const removed or
	// param type changed) use the closest available override and adjust.
	virtual bool CanExecuteOnlyOnMainThread(FPCGContext* Context) const override { return true; }
};
