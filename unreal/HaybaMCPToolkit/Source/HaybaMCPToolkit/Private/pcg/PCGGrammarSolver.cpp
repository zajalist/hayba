#include "pcg/PCGGrammarSolver.h"

#include "PCGContext.h"
#include "PCGPin.h"
#include "PCGCommon.h"
#include "Data/PCGSplineData.h"
#include "Data/PCGDynamicMeshData.h"
#include "Data/PCGBasePointData.h"
#include "PCGPoint.h"                 // FPCGPoint (explicit; do not rely on transitive)
#include "PCGPointPropertiesTraits.h" // EPCGPointNativeProperties flags
#include "Metadata/PCGMetadata.h"
#include "Metadata/PCGMetadataAttributeTpl.h"
#include "Materials/MaterialInterface.h"
#include "Engine/StaticMesh.h"

#include "DynamicMesh/DynamicMesh3.h"
#include "DynamicMesh/MeshNormals.h"
#include "DynamicMesh/Operations/MergeCoincidentMeshEdges.h" // weld co-located edges before normals
#include "IndexTypes.h"

#include "HAL/PlatformMisc.h" // FPlatformMisc::GetEnvironmentVariable
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include UE_INLINE_GENERATED_CPP_BY_NAME(PCGGrammarSolver)

#define LOCTEXT_NAMESPACE "PCGGrammarSolver"

// ---------------------------------------------------------------------------
// Local mirrors of the grammar.json contract (REFERENCE 3). These are minimal
// PODs sufficient for the expansion port; the full TS types carry more.
// ---------------------------------------------------------------------------
namespace HaybaGrammar
{
	// A single EmitOp, stored generically. We keep the discriminator (Emit) plus
	// the fields the geometry slice consumes; the raw JsonObject is retained so
	// PlacedItem.meta can carry the whole op forward (the {...op} shallow spread).
	struct FEmitOp
	{
		FString Emit;                       // shell | asset | symbol | scatter | decal | fill
		FString Role;                       // shell/asset/decal/fill
		FString Tag;                        // scatter
		FString Kind;                       // symbol (child kind)
		FString Along;                      // asset/decal
		FString At;                         // asset/fill
		bool    bHasLen = false;            // symbol
		double  Len = 0.0;                  // symbol
		bool    bHasSpacing = false;        // asset
		double  SpacingM = 0.0;             // asset
		bool    bAlternate = false;         // asset
		bool    bHasBendAt = false;         // shell (vent)
		double  BendAtM = 0.0;              // shell (vent)
		TSharedPtr<FJsonObject> Raw;        // the whole op, for meta
	};

	// when-clause entry: key (already stripped of any _gt suffix), the raw value
	// (typed), and whether this was a "_gt" greater-than comparison.
	struct FWhenClause
	{
		FString Key;
		bool    bGreaterThan = false;
		TSharedPtr<FJsonValue> Value;
	};

	struct FProduction
	{
		FString Id;
		FString LhsKind;
		TArray<FWhenClause> When;           // empty => always matches
		TArray<FEmitOp> Rhs;
		TArray<FString> Guards;
		double Priority = 0.0;
		// Stable tie-break key. Derived from TMap<FString,..> traversal order of the
		// parsed JSON object. For a freshly parsed object with no removals this
		// USUALLY equals file textual order (matching the TS reference, which relies
		// on JS object-key insertion order), but TMap does NOT contractually preserve
		// insertion order. Equal-priority ties are therefore resolved by this captured
		// traversal order, which is deterministic within a build but not guaranteed to
		// equal file textual order across engine/reader versions.
		int32 InsertionOrder = 0;
	};

	// Symbol attribute value: a tagged union mirroring JSON (number | string | bool).
	// Strict equality in whenMatches requires type AND value to match.
	struct FAttr
	{
		enum class EType : uint8 { Number, String, Bool } Type = EType::Number;
		double  Num = 0.0;
		FString Str;
		bool    Bool = false;

		static FAttr MakeNum(double V)  { FAttr A; A.Type = EType::Number; A.Num = V; return A; }
		static FAttr MakeStr(const FString& V) { FAttr A; A.Type = EType::String; A.Str = V; return A; }
		static FAttr MakeBool(bool V)   { FAttr A; A.Type = EType::Bool; A.Bool = V; return A; }
	};

	struct FSymbol
	{
		FString Kind;
		TMap<FString, FAttr> Attrs;
	};

	// A flattened, emitted placement (mirror of PlacedItem). symbolKind is the
	// CURRENT symbol's kind; meta is the whole op (kept as the FEmitOp).
	struct FPlacedItem
	{
		FString Kind;        // op.emit
		FString Role;
		FString Tag;
		FString SymbolKind;
		int32   Index = 0;
		FEmitOp Op;          // == meta {...op}; carries Along/At/Spacing/etc.
	};
}

// ---------------------------------------------------------------------------
// JSON -> attr/op helpers
// ---------------------------------------------------------------------------
namespace HaybaGrammar
{
	static FAttr JsonValueToAttr(const TSharedPtr<FJsonValue>& V)
	{
		if (!V.IsValid())
		{
			return FAttr::MakeNum(0.0);
		}
		switch (V->Type)
		{
		case EJson::Number:  return FAttr::MakeNum(V->AsNumber());
		case EJson::Boolean: return FAttr::MakeBool(V->AsBool());
		case EJson::String:  return FAttr::MakeStr(V->AsString());
		default:             return FAttr::MakeStr(V->AsString());
		}
	}

	// Strict (===) equality of a symbol attr against a JSON when-value: type AND value.
	static bool AttrStrictEquals(const FAttr* SymAttr, const TSharedPtr<FJsonValue>& WhenVal)
	{
		if (!SymAttr || !WhenVal.IsValid())
		{
			return false; // missing attr -> never strictly equal
		}
		switch (WhenVal->Type)
		{
		case EJson::Number:
			return SymAttr->Type == FAttr::EType::Number && SymAttr->Num == WhenVal->AsNumber();
		case EJson::Boolean:
			return SymAttr->Type == FAttr::EType::Bool && SymAttr->Bool == WhenVal->AsBool();
		case EJson::String:
			return SymAttr->Type == FAttr::EType::String && SymAttr->Str == WhenVal->AsString();
		default:
			return false;
		}
	}

	// Numeric greater-than for the _gt suffix. Missing attr or non-number -> false
	// (mirrors `undefined > v` === false, and only numeric `>` is defined).
	static bool AttrGreaterThan(const FAttr* SymAttr, const TSharedPtr<FJsonValue>& WhenVal)
	{
		if (!SymAttr || !WhenVal.IsValid() || WhenVal->Type != EJson::Number)
		{
			return false;
		}
		if (SymAttr->Type != FAttr::EType::Number)
		{
			return false;
		}
		return SymAttr->Num > WhenVal->AsNumber();
	}

	// whenMatches(sym, when) — REFERENCE 3 (grammar.ts L24-33).
	static bool WhenMatches(const FSymbol& Sym, const TArray<FWhenClause>& When)
	{
		for (const FWhenClause& C : When)
		{
			const FAttr* A = Sym.Attrs.Find(C.Key);
			if (C.bGreaterThan)
			{
				if (!AttrGreaterThan(A, C.Value)) { return false; }
			}
			else
			{
				if (!AttrStrictEquals(A, C.Value)) { return false; }
			}
		}
		return true; // undefined/empty when => always matches
	}

	// Parse one EmitOp object.
	static bool ParseEmitOp(const TSharedPtr<FJsonObject>& Obj, FEmitOp& Out)
	{
		if (!Obj.IsValid()) { return false; }
		if (!Obj->TryGetStringField(TEXT("emit"), Out.Emit) || Out.Emit.IsEmpty())
		{
			return false;
		}
		Obj->TryGetStringField(TEXT("role"), Out.Role);
		Obj->TryGetStringField(TEXT("tag"), Out.Tag);
		Obj->TryGetStringField(TEXT("kind"), Out.Kind);
		Obj->TryGetStringField(TEXT("along"), Out.Along);
		Obj->TryGetStringField(TEXT("at"), Out.At);

		double Tmp = 0.0;
		if (Obj->TryGetNumberField(TEXT("len"), Tmp))       { Out.bHasLen = true; Out.Len = Tmp; }
		if (Obj->TryGetNumberField(TEXT("spacing_m"), Tmp)) { Out.bHasSpacing = true; Out.SpacingM = Tmp; }
		if (Obj->TryGetNumberField(TEXT("bend_at_m"), Tmp)) { Out.bHasBendAt = true; Out.BendAtM = Tmp; }
		Obj->TryGetBoolField(TEXT("alternate"), Out.bAlternate);

		Out.Raw = Obj;
		return true;
	}

	// Parse the whole grammar.json object: { "<id>": Production, ... }.
	// InsertionOrder captures TMap traversal order for the stable tie-break. This
	// approximates (but is NOT contractually) JSON file textual order — see the
	// FProduction::InsertionOrder note. Equal-priority ties resolve by it deterministically.
	static void ParseGrammar(const TSharedPtr<FJsonObject>& Root, TArray<FProduction>& OutProds)
	{
		if (!Root.IsValid()) { return; }

		int32 Order = 0;
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Kv : Root->Values)
		{
			if (!Kv.Value.IsValid() || Kv.Value->Type != EJson::Object) { continue; }
			// AsObject() returns a non-null const ref into the FJsonValueObject; only
			// its validity can fail, so bind a const ref and gate on IsValid().
			const TSharedPtr<FJsonObject>& ProdObj = Kv.Value->AsObject();
			if (!ProdObj.IsValid()) { continue; }

			FProduction P;
			P.InsertionOrder = Order++;
			// id: prefer the explicit field, fall back to the map key.
			if (!ProdObj->TryGetStringField(TEXT("id"), P.Id) || P.Id.IsEmpty())
			{
				P.Id = Kv.Key;
			}

			// lhs { kind, when? }
			const TSharedPtr<FJsonObject>* LhsPtr = nullptr;
			if (ProdObj->TryGetObjectField(TEXT("lhs"), LhsPtr) && LhsPtr && (*LhsPtr).IsValid())
			{
				(*LhsPtr)->TryGetStringField(TEXT("kind"), P.LhsKind);
				const TSharedPtr<FJsonObject>* WhenPtr = nullptr;
				if ((*LhsPtr)->TryGetObjectField(TEXT("when"), WhenPtr) && WhenPtr && (*WhenPtr).IsValid())
				{
					for (const TPair<FString, TSharedPtr<FJsonValue>>& WKv : (*WhenPtr)->Values)
					{
						FWhenClause Clause;
						FString K = WKv.Key;
						if (K.EndsWith(TEXT("_gt")))
						{
							Clause.bGreaterThan = true;
							Clause.Key = K.LeftChop(3); // strip last 3 chars
						}
						else
						{
							Clause.Key = K;
						}
						Clause.Value = WKv.Value;
						P.When.Add(Clause);
					}
				}
			}

			// rhs[] — required non-empty per validateProduction; skip invalid prods.
			const TArray<TSharedPtr<FJsonValue>>* RhsArr = nullptr;
			if (ProdObj->TryGetArrayField(TEXT("rhs"), RhsArr) && RhsArr)
			{
				for (const TSharedPtr<FJsonValue>& OV : *RhsArr)
				{
					if (!OV.IsValid() || OV->Type != EJson::Object) { continue; }
					FEmitOp Op;
					if (ParseEmitOp(OV->AsObject(), Op))
					{
						P.Rhs.Add(Op);
					}
				}
			}

			// guards[]
			const TArray<TSharedPtr<FJsonValue>>* GArr = nullptr;
			if (ProdObj->TryGetArrayField(TEXT("guards"), GArr) && GArr)
			{
				for (const TSharedPtr<FJsonValue>& GV : *GArr)
				{
					if (GV.IsValid() && GV->Type == EJson::String)
					{
						P.Guards.Add(GV->AsString());
					}
				}
			}

			// priority
			ProdObj->TryGetNumberField(TEXT("priority"), P.Priority);

			// validateProduction: non-empty id, non-empty lhs.kind, non-empty rhs.
			// NOTE (deliberate asymmetry): C++ is STRICTER than the TS read path here.
			// TS listProductions() returns the stored objects verbatim (validateProduction
			// is a WRITE-side guard only), so a malformed/hand-edited production on disk is
			// still expanded by TS. C++ drops it at load. This is intentional hardening; the
			// two implementations are byte-identical only for well-formed grammar.json.
			if (P.Id.IsEmpty() || P.LhsKind.IsEmpty() || P.Rhs.Num() == 0)
			{
				continue;
			}
			OutProds.Add(MoveTemp(P));
		}
	}

	// ---------------------------------------------------------------------------
	// PCG metadata attribute read helpers (Task 4).
	// Both return the Default when: Data is null, ConstMetadata() returns null,
	// the named attribute does not exist (or has the wrong type), or there are no
	// metadata entries. The first entry key (PCGInvalidEntryKey == 0 when absent,
	// PCGFirstEntryKey == 0 for the first real entry) is used — reading entry 0 is
	// safe because metadata always initialises entry 0 for single-item data.
	// ---------------------------------------------------------------------------
	static FString ReadStrAttr(const UPCGData* Data, FName Name, const FString& Default)
	{
		if (!Data) { return Default; }
		const UPCGMetadata* Md = Data->ConstMetadata();
		if (!Md) { return Default; }
		// GetConstTypedAttribute<T> does the type-id check; returns null if absent or wrong type.
		const FPCGMetadataAttribute<FString>* Attr = Md->GetConstTypedAttribute<FString>(Name);
		if (!Attr) { return Default; }
		// PCGFirstEntryKey == 0; valid for single-item data (spline input has exactly one entry).
		return Attr->GetValue(PCGFirstEntryKey);
	}

	static double ReadNumAttr(const UPCGData* Data, FName Name, double Default)
	{
		if (!Data) { return Default; }
		const UPCGMetadata* Md = Data->ConstMetadata();
		if (!Md) { return Default; }
		const FPCGMetadataAttribute<double>* Attr = Md->GetConstTypedAttribute<double>(Name);
		if (!Attr) { return Default; }
		return Attr->GetValue(PCGFirstEntryKey);
	}

	// matchProductions(sym, prods) — filter by kind+when, sort priority DESC,
	// STABLE for ties (captured TMap traversal order; see InsertionOrder note —
	// approximates TS file textual order but is not a hard contract). REFERENCE 3 (L35-39).
	static void MatchProductions(const FSymbol& Sym, const TArray<FProduction>& Prods, TArray<const FProduction*>& Out)
	{
		for (const FProduction& P : Prods)
		{
			if (P.LhsKind == Sym.Kind && WhenMatches(Sym, P.When))
			{
				Out.Add(&P);
			}
		}
		// Stable sort: priority DESC, tie -> lower InsertionOrder first.
		Out.StableSort([](const FProduction& A, const FProduction& B)
		{
			if (A.Priority != B.Priority)
			{
				return A.Priority > B.Priority; // DESC
			}
			return A.InsertionOrder < B.InsertionOrder;
		});
	}

	// ---------------------------------------------------------------------------
	// Junction-typing rule. Mirrors Task 2 TS rule: imperial+imperial -> Portal,
	// native+native -> BooleanUnion, mixed -> Clash. Not yet wired (Tasks 8/9).
	// ---------------------------------------------------------------------------
	enum class EJunctionType : uint8 { Portal, BooleanUnion, Clash };
	static EJunctionType JunctionTypeFor(const FString& A, const FString& B)
	{
		if (A == TEXT("imperial") && B == TEXT("imperial")) return EJunctionType::Portal;
		if (A == TEXT("native")   && B == TEXT("native"))   return EJunctionType::BooleanUnion;
		return EJunctionType::Clash;
	}
}

// ---------------------------------------------------------------------------
// Guard hook. SCOPE NOTE (read this): the full constraint engine lives in TS.
// In C++ we evaluate ONLY the two STRUCTURAL guards the geometry needs:
//   * "clearance" family -> keep a >=1.2 m walkway when placing columns.
//   * "max_straight_run" / "no_straight_air" -> force the vent shaft to bend at
//     <= 6 m, so a straight-shaft shell production HARD-FAILS and the bent one wins.
// EVERY OTHER guard id PASSES (returns no hard-fail). This mirrors expandGrammar's
// guards callback: returns { hardFail, softFails }.
// ---------------------------------------------------------------------------
namespace HaybaGrammar
{
	struct FGuardVerdict
	{
		bool bHardFail = false;
		TArray<FString> SoftFails;
	};

	// Min walkway we protect when placing floor-edge columns (metres).
	static constexpr double kClearanceMinM = 1.2;
	// A "straight run" of unsupported air longer than this must bend (metres).
	static constexpr double kMaxStraightRunM = 6.0;

	static bool GuardIdIsClearance(const FString& Id)
	{
		return Id.Contains(TEXT("clearance"));
	}
	static bool GuardIdIsStraightRun(const FString& Id)
	{
		return Id.Contains(TEXT("max_straight_run")) || Id.Contains(TEXT("no_straight_air"));
	}

	// EvalGuards: ops + sym describe the production being tried.
	// Returns hardFail when a structural guard cannot be satisfied.
	static FGuardVerdict EvalGuards(const TArray<FString>& Guards, const TArray<FEmitOp>& Ops, const FSymbol& Sym)
	{
		FGuardVerdict V;
		for (const FString& Id : Guards)
		{
			if (GuardIdIsClearance(Id))
			{
				// Clearance applies to column placement: ensure the bore width leaves
				// a >=1.2 m walkway between the two staggered column lines. Columns sit
				// at +/-(w/2 - 0.1) m, so the gap is (w - 0.2) m. If that drops below
				// the min walkway, the placement is unsafe -> hard fail.
				const FAttr* W = Sym.Attrs.Find(TEXT("w"));
				const bool bPlacesColumns = Ops.ContainsByPredicate([](const FEmitOp& O)
				{
					return O.Emit == TEXT("asset") && O.Role == TEXT("column");
				});
				if (bPlacesColumns && W && W->Type == FAttr::EType::Number)
				{
					const double Walkway = W->Num - 0.2;
					if (Walkway < kClearanceMinM)
					{
						V.bHardFail = true;
						V.SoftFails.Add(FString::Printf(TEXT("clearance:%.2fm<%.2fm"), Walkway, kClearanceMinM));
						return V;
					}
				}
				// Not a column-placing op, or width OK -> this guard passes.
			}
			else if (GuardIdIsStraightRun(Id))
			{
				// Straight-air guard applies to vent shells. A shell op WITHOUT a bend
				// (no bend_at_m), or whose bend is beyond the max straight run, leaves
				// too much unsupported straight air -> hard fail (so the straight-shaft
				// production is rejected and the bent variant, which sets bend_at_m
				// <= 6 m, wins).
				const FEmitOp* VentShell = Ops.FindByPredicate([](const FEmitOp& O)
				{
					return O.Emit == TEXT("shell") && O.Role == TEXT("vent");
				});
				if (VentShell)
				{
					const bool bBendsInTime = VentShell->bHasBendAt && VentShell->BendAtM <= kMaxStraightRunM;
					if (!bBendsInTime)
					{
						V.bHardFail = true;
						V.SoftFails.Add(TEXT("no_straight_air:vent-must-bend<=6m"));
						return V;
					}
				}
				// No vent shell in this production -> guard passes.
			}
			// ALL OTHER guard ids: PASS (full eval is in TS). No-op.
		}
		return V;
	}
}

// ---------------------------------------------------------------------------
// expandGrammar(seed, prods, guards) — faithful BFS port. REFERENCE 3 (L41-90).
// MAX_DEPTH=6, MAX_ITEMS=512. FIFO queue. First non-hard-failing production wins;
// only ONE production commits per symbol; idx increments only for emitted items.
// ---------------------------------------------------------------------------
namespace HaybaGrammar
{
	struct FPlacementPlan
	{
		TArray<FPlacedItem> Items;
		TArray<FString> Weaknesses;
		TArray<FString> Rejected;
	};

	static void ExpandGrammar(const FSymbol& Seed, const TArray<FProduction>& Prods, FPlacementPlan& Plan)
	{
		static constexpr int32 MAX_DEPTH = 6;
		static constexpr int32 MAX_ITEMS = 512;

		struct FWork { FSymbol Sym; int32 Depth; };
		TArray<FWork> Queue; // used as FIFO: pop front (index 0), push back.
		Queue.Add({ Seed, 0 });

		int32 Idx = 0;
		int32 Head = 0; // avoid O(n) RemoveAt(0) churn while preserving FIFO order.

		while (Head < Queue.Num() && Plan.Items.Num() < MAX_ITEMS)
		{
			const FWork Work = Queue[Head++];
			if (Work.Depth > MAX_DEPTH)
			{
				continue;
			}

			TArray<const FProduction*> Matched;
			MatchProductions(Work.Sym, Prods, Matched);

			bool bCommitted = false;
			for (const FProduction* Prod : Matched)
			{
				const FGuardVerdict Verdict = EvalGuards(Prod->Guards, Prod->Rhs, Work.Sym);
				if (Verdict.bHardFail)
				{
					Plan.Rejected.Add(Prod->Id);
					continue; // try the next (lower-priority) production
				}

				// This production commits.
				Plan.Weaknesses.Append(Verdict.SoftFails);
				for (const FEmitOp& Op : Prod->Rhs)
				{
					if (Op.Emit == TEXT("symbol"))
					{
						// Child attrs = parent attrs spread, then len overwritten.
						FSymbol Child;
						Child.Kind = Op.Kind;
						Child.Attrs = Work.Sym.Attrs;
						Child.Attrs.Add(TEXT("len"), FAttr::MakeNum(Op.bHasLen ? Op.Len : 0.0));
						Queue.Add({ MoveTemp(Child), Work.Depth + 1 });
					}
					else
					{
						FPlacedItem Item;
						Item.Kind = Op.Emit;
						Item.Role = Op.Role;
						Item.Tag = Op.Tag;
						Item.SymbolKind = Work.Sym.Kind;
						Item.Index = Idx++;
						Item.Op = Op; // meta = {...op}
						Plan.Items.Add(MoveTemp(Item));
					}
				}
				bCommitted = true;
				break; // only ONE production commits per symbol
			}

			if (!bCommitted)
			{
				Plan.Rejected.Add(FString::Printf(TEXT("<no-production:%s>"), *Work.Sym.Kind));
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Settings boilerplate
// ---------------------------------------------------------------------------
#if WITH_EDITOR
FText UPCGGrammarSolverSettings::GetDefaultNodeTitle() const
{
	return LOCTEXT("Title", "Grammar Solver");
}
FText UPCGGrammarSolverSettings::GetNodeTooltipText() const
{
	return LOCTEXT("Tooltip", "Reads grammar.json, expands a seed symbol via a production worklist, and emits placed points (columns, scattered rubble) on Out plus a welded inner shell (walls + bent vent) on Shell. Deterministic; structural guards (clearance, straight-air) evaluated in C++, full constraints in TS.");
}
#endif

TArray<FPCGPinProperties> UPCGGrammarSolverSettings::InputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::PointOrSpline);
	return Pins;
}

TArray<FPCGPinProperties> UPCGGrammarSolverSettings::OutputPinProperties() const
{
	TArray<FPCGPinProperties> Pins;
	// Default "Out" = placed points (columns + rubble).
	Pins.Emplace(PCGPinConstants::DefaultOutputLabel, EPCGDataType::Point);
	// "Shell" = welded inner shell (walls + bent vent) dynamic mesh.
	Pins.Emplace(FName(TEXT("Shell")), EPCGDataType::DynamicMesh, /*bAllowMultipleConnections=*/false, /*bAllowMultipleData=*/false);
	return Pins;
}

FPCGElementPtr UPCGGrammarSolverSettings::CreateElement() const
{
	return MakeShared<FPCGGrammarSolverElement>();
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------
namespace
{
	// The 6 rubble meshes (REFERENCE 4), round-robined by index % 6.
	static const TCHAR* GRubbleMeshPaths[] = {
		TEXT("/Game/Fab/Megascans/3D/Cement_Rubble_rinet/Medium/rinet_tier_2/StaticMeshes/rinet_tier_2.rinet_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_tfxteboda/Medium/tfxteboda_tier_2/StaticMeshes/tfxteboda_tier_2.tfxteboda_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_tgdtfg0da/Medium/tgdtfg0da_tier_2/StaticMeshes/tgdtfg0da_tier_2.tgdtfg0da_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Concrete_Rubble_Pile_ujriaadga/Medium/ujriaadga_tier_2/StaticMeshes/ujriaadga_tier_2.ujriaadga_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Construction_Rubble_rigrp/Medium/rigrp_tier_2/StaticMeshes/rigrp_tier_2.rigrp_tier_2"),
		TEXT("/Game/Fab/Megascans/3D/Stone_Rubble_Pile_udxlfezfa/Medium/udxlfezfa_tier_2/StaticMeshes/udxlfezfa_tier_2.udxlfezfa_tier_2"),
	};
	static constexpr int32 kNumRubble = 6;

	// Attribute name a downstream PCGStaticMeshSpawner (MeshSelectorByAttribute)
	// reads to pick the per-point mesh. Type MUST be FSoftObjectPath (REFERENCE 2c).
	static const FName kMeshAttributeName(TEXT("Mesh"));

	// Deterministic 0..1 jitter from (kind + index). NO FMath::Rand.
	// Mixes the FString hash with two integers via a fixed multiplicative hash
	// (Knuth's 2654435761) so the result is stable across runs and platforms.
	static double DeterministicUnit(const FString& Kind, int32 IndexA, int32 IndexB)
	{
		uint32 H = GetTypeHash(Kind);
		H ^= (uint32)IndexA * 2654435761u;
		H = (H << 13) | (H >> 19); // rotate to spread bits
		H ^= (uint32)IndexB * 2246822519u;
		// Map to [0,1): use the top 24 bits for a stable fraction.
		return (double)(H & 0xFFFFFFu) / (double)0x1000000u;
	}

	// Resolve the grammar.json path, honoring HAYBA_GRAMMAR / HAYBA_PROFILES env,
	// then the Settings override, then <ProjectDir>/.scratch/grammar.json.
	static FString ResolveGrammarPath(const FString& SettingsPath)
	{
		// 1) Explicit settings path wins if set.
		if (!SettingsPath.IsEmpty())
		{
			return SettingsPath;
		}
		// 2) HAYBA_GRAMMAR (full path).
		const FString EnvGrammar = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_GRAMMAR"));
		if (!EnvGrammar.IsEmpty())
		{
			return EnvGrammar;
		}
		// 3) HAYBA_PROFILES -> grammar.json in its directory.
		const FString EnvProfiles = FPlatformMisc::GetEnvironmentVariable(TEXT("HAYBA_PROFILES"));
		if (!EnvProfiles.IsEmpty())
		{
			return FPaths::Combine(FPaths::GetPath(EnvProfiles), TEXT("grammar.json"));
		}
		// 4) <ProjectDir>/.scratch/grammar.json.
		return FPaths::Combine(FPaths::ProjectDir(), TEXT(".scratch"), TEXT("grammar.json"));
	}
}

bool FPCGGrammarSolverElement::ExecuteInternal(FPCGContext* Context) const
{
	using namespace UE::Geometry;
	using namespace HaybaGrammar;
	TRACE_CPUPROFILER_EVENT_SCOPE(FPCGGrammarSolverElement::Execute);
	check(Context);

	const UPCGGrammarSolverSettings* Settings = Context->GetInputSettings<UPCGGrammarSolverSettings>();
	check(Settings);

	UMaterialInterface* ShellMat = Settings->ShellMaterial.LoadSynchronous();
	const FSoftObjectPath ColumnMeshPath = Settings->ColumnMesh.ToSoftObjectPath();

	// ---- Load + parse grammar.json once (REFERENCE 4 idiom). Missing file => {}.
	TArray<FProduction> Prods;
	{
		const FString GrammarFile = ResolveGrammarPath(Settings->GrammarPath);
		FString Raw;
		if (FFileHelper::LoadFileToString(Raw, *GrammarFile))
		{
			TSharedPtr<FJsonObject> Root;
			TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Raw);
			if (FJsonSerializer::Deserialize(Reader, Root) && Root.IsValid())
			{
				ParseGrammar(Root, Prods);
			}
			// Parse failure -> empty production set (silent fallback, like the TS store).
		}
		// Missing file -> empty production set; the seed yields a single rejected sentinel.
	}

	const TArray<FPCGTaggedData> Inputs = Context->InputData.GetInputsByPin(PCGPinConstants::DefaultInputLabel);
	for (const FPCGTaggedData& In : Inputs)
	{
		// ---- Determine kind early so we can branch to the room path before any
		// spline cast. Metadata is present on both spline and point data.
		const UPCGData* InData = In.Data;
		// Kind is determined by INPUT DATA TYPE (no 'kind' attribute): point data
		// => room, spline data => tunnel. Per-primitive attributes (builder/w/h/...)
		// still come from the DATA-domain metadata via ReadStr/NumAttr.
		const bool bIsRoom = (Cast<UPCGBasePointData>(InData) != nullptr);
		const FString EarlyKind = bIsRoom ? TEXT("room") : TEXT("tunnel");

		// ====================================================================
		// ROOM PATH: kind == "room"
		// Input is a single UPCGBasePointData point whose Transform.Location is
		// the room center and Transform.Scale3D carries the full box dimensions (cm).
		// Only "imperial" builder is realized here; "native" is a TODO (Task 7).
		// ====================================================================
		if (EarlyKind == TEXT("room"))
		{
			const UPCGBasePointData* PointData = Cast<UPCGBasePointData>(InData);
			if (!PointData || PointData->GetNumPoints() == 0)
			{
				// No usable point — skip this input silently.
				continue;
			}

			// Read the builder attr from metadata (same helper used by the tunnel path).
			const FString BuilderAttr = ReadStrAttr(InData, FName(TEXT("builder")), TEXT("native"));

			if (BuilderAttr != TEXT("imperial"))
			{
				// TODO(Task 7): native room builder. No-op for now.
				continue;
			}

			// ---- Read room geometry from the first point.
			// UE 5.7 UPCGBasePointData is SoA; GetPoint(int32) lives on the value-range
			// view, not the data object. The direct per-property accessor is
			// GetTransform(int32) (PCGBasePointData.h:223).
			const FTransform RoomXf = PointData->GetTransform(0);
			const FVector Center   = RoomXf.GetLocation();
			const FVector FullSize = RoomXf.GetScale3D(); // full box dims (cm)

			// ---- Build the shell mesh (closed inward-facing box).
			FDynamicMesh3 Mesh;
			Mesh.EnableAttributes();
			Mesh.Attributes()->EnableMaterialID();
			Mesh.Attributes()->SetNumUVLayers(1);
			bool bAnyShell = false;

			// AddRoomShellImperial: appends a CLOSED welded box shell with 8 shared
			// corner vertices and 12 triangles (6 faces × 2). All faces wind so their
			// computed normal points INWARD (toward the room centre).
			//
			// Winding strategy: for each face we compute the geometric normal of the
			// first triangle (cross product of edges from the first vertex) and compare
			// it to the desired inward direction. If the dot product is negative the
			// natural CCW winding already points inward; otherwise we swap the second and
			// third indices to flip. This is the same per-face flip used by AddQuad so
			// the scheme is consistent across the whole file.
			//
			// Corner layout (right-hand, Z-up):
			//   v0 = (-hx, -hy, -hz)  v1 = (+hx, -hy, -hz)
			//   v2 = (+hx, +hy, -hz)  v3 = (-hx, +hy, -hz)
			//   v4 = (-hx, -hy, +hz)  v5 = (+hx, -hy, +hz)
			//   v6 = (+hx, +hy, +hz)  v7 = (-hx, +hy, +hz)
			//
			// Each face names its 4 corners in a consistent CCW order when viewed from
			// the OUTSIDE; the flip then inverts the winding so normals point inward.
			auto AddRoomShellImperial = [&](const FVector& Ctr, const FVector& Size)
			{
				const FVector H = Size * 0.5; // half-extents

				// 8 shared corner vertices. Indices stored for face indexing.
				const int32 V[8] = {
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, -H.Y, -H.Z))), // 0 BLL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, -H.Y, -H.Z))), // 1 BRL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, +H.Y, -H.Z))), // 2 BRR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, +H.Y, -H.Z))), // 3 BLR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, -H.Y, +H.Z))), // 4 TLL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, -H.Y, +H.Z))), // 5 TRL
					Mesh.AppendVertex(FVector3d(Ctr + FVector(+H.X, +H.Y, +H.Z))), // 6 TRR
					Mesh.AppendVertex(FVector3d(Ctr + FVector(-H.X, +H.Y, +H.Z)))  // 7 TLR
				};

				// AddFace: two triangles from a quad, flipped so the normal points
				// toward InwardDir (into the room). Sets per-triangle material ID and
				// per-wedge planar UVs (dots with UAxis/VAxis, cm→tiles at 1m scale).
				FDynamicMeshUVOverlay*         UVOv    = Mesh.Attributes()->PrimaryUV();
				FDynamicMeshMaterialAttribute* MatAttr = Mesh.Attributes()->GetMaterialID();
				auto AddFace = [&](int32 a, int32 b, int32 c, int32 d,
				                   const FVector3d& InwardDir,
				                   int32 MatId,
				                   const FVector3d& UAxis, const FVector3d& VAxis)
				{
					// Planar UV per corner: project world position onto face axes, cm→tiles.
					auto UVof = [&](int32 vi)
					{
						const FVector3d P = Mesh.GetVertex(vi);
						return FVector2f((float)(P.Dot(UAxis) / 100.0), (float)(P.Dot(VAxis) / 100.0));
					};
					const int32 ea = UVOv->AppendElement(UVof(a));
					const int32 eb = UVOv->AppendElement(UVof(b));
					const int32 ec = UVOv->AppendElement(UVof(c));
					const int32 ed = UVOv->AppendElement(UVof(d));

					// Triangle ABC: natural CCW normal = (B-A) x (C-A)
					const FVector3d pa = Mesh.GetVertex(a);
					const FVector3d pb = Mesh.GetVertex(b);
					const FVector3d pc = Mesh.GetVertex(c);
					const FVector3d n  = (pb - pa).Cross(pc - pa);
					int32 t0, t1;
					if (n.Dot(InwardDir) < 0.0)
					{
						// Natural winding already faces inward — keep it.
						t0 = Mesh.AppendTriangle(FIndex3i(a, b, c));
						t1 = Mesh.AppendTriangle(FIndex3i(a, c, d));
						if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(ea, eb, ec)); MatAttr->SetValue(t0, MatId); }
						if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(ea, ec, ed)); MatAttr->SetValue(t1, MatId); }
					}
					else
					{
						// Natural winding faces outward — flip.
						t0 = Mesh.AppendTriangle(FIndex3i(a, c, b));
						t1 = Mesh.AppendTriangle(FIndex3i(a, d, c));
						if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(ea, ec, eb)); MatAttr->SetValue(t0, MatId); }
						if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(ea, ed, ec)); MatAttr->SetValue(t1, MatId); }
					}
				};

				// 6 faces; inward normal = direction from face toward centre.
				// Slot 0 = floor/ceiling, Slot 1 = walls.
				// Floor   (Z-): inward +Z, planar XY
				AddFace(V[0], V[1], V[2], V[3], FVector3d( 0,  0, +1), 0, FVector3d(1,0,0), FVector3d(0,1,0));
				// Ceiling (Z+): inward -Z, planar XY
				AddFace(V[4], V[5], V[6], V[7], FVector3d( 0,  0, -1), 0, FVector3d(1,0,0), FVector3d(0,1,0));
				// Front   (Y-): inward +Y, planar XZ
				AddFace(V[0], V[1], V[5], V[4], FVector3d( 0, +1,  0), 1, FVector3d(1,0,0), FVector3d(0,0,1));
				// Back    (Y+): inward -Y, planar XZ
				AddFace(V[3], V[2], V[6], V[7], FVector3d( 0, -1,  0), 1, FVector3d(1,0,0), FVector3d(0,0,1));
				// Left    (X-): inward +X, planar YZ
				AddFace(V[0], V[3], V[7], V[4], FVector3d(+1,  0,  0), 1, FVector3d(0,1,0), FVector3d(0,0,1));
				// Right   (X+): inward -X, planar YZ
				AddFace(V[1], V[2], V[6], V[5], FVector3d(-1,  0,  0), 1, FVector3d(0,1,0), FVector3d(0,0,1));
			};

			AddRoomShellImperial(Center, FullSize);
			bAnyShell = true;

			// ---- Weld + normals + emit on Shell pin (same path as the tunnel shell).
			if (bAnyShell && Mesh.TriangleCount() > 0)
			{
				FMergeCoincidentMeshEdges Welder(&Mesh);
				Welder.Apply();

				FMeshNormals::QuickRecomputeOverlayNormals(Mesh);

				UPCGDynamicMeshData* ShellData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
				// Slot 0 = floor/ceiling material; Slot 1 = wall material.
				// Fall back to ShellMat for any slot whose asset isn't found at cook time.
				UMaterialInterface* FCMat   = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomFloorCeil.MI_RoomFloorCeil")));
				UMaterialInterface* WallMat = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomWall.MI_RoomWall")));
				TArray<UMaterialInterface*> RoomMats;
				RoomMats.Add(FCMat   ? FCMat   : ShellMat); // slot 0: floor + ceiling
				RoomMats.Add(WallMat ? WallMat : ShellMat); // slot 1: walls
				ShellData->Initialize(MoveTemp(Mesh), RoomMats);

				FPCGTaggedData& OutShell = Context->OutputData.TaggedData.Emplace_GetRef();
				OutShell.Data = ShellData;
				OutShell.Pin = FName(TEXT("Shell"));
				OutShell.Tags = In.Tags;
			}

			// Room path does not emit any Out points for now (no grammar expansion).
			continue; // skip the spline/tunnel path below for this input
		}

		// ====================================================================
		// TUNNEL PATH (unchanged): kind != "room" — requires a spline input.
		// ====================================================================
		const UPCGSplineData* Spline = Cast<UPCGSplineData>(In.Data);
		if (!Spline)
		{
			continue;
		}

		const FPCGSplineStruct& SS = Spline->SplineStruct;
		const double TotalLen = SS.GetSplineLength();
		const int32 NumCP = SS.GetNumberOfPoints();
		if (TotalLen < 1.0 || NumCP < 2)
		{
			continue;
		}

		const double LenMetres = TotalLen / 100.0; // UE units are cm.

		// ---- Seed symbol: read per-primitive attributes from input data metadata,
		// falling back to the original literals when an attribute is absent.
		const int32 PrimId = (int32)ReadNumAttr(InData, FName(TEXT("prim_id")),    0.0); // stashed for Task 8/9
		(void)PrimId; // Task 8/9 will use this; suppress unused-variable warning until then.
		FSymbol Seed;
		Seed.Kind = EarlyKind; // already read above
		Seed.Attrs.Add(TEXT("builder"),    FAttr::MakeStr(ReadStrAttr(InData, FName(TEXT("builder")),   TEXT("native"))));
		Seed.Attrs.Add(TEXT("phase"),      FAttr::MakeStr(ReadStrAttr(InData, FName(TEXT("phase")),     TEXT("I"))));
		Seed.Attrs.Add(TEXT("importance"), FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("importance")), 0.3)));
		Seed.Attrs.Add(TEXT("len"),        FAttr::MakeNum(LenMetres)); // always computed from spline length
		Seed.Attrs.Add(TEXT("w"),          FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("w")),          1.8)));
		Seed.Attrs.Add(TEXT("h"),          FAttr::MakeNum(ReadNumAttr(InData, FName(TEXT("h")),          2.4)));
		// seed (int32 read as double, cast): stored as number attr on the symbol if non-zero.
		{
			const int32 SeedVal = (int32)ReadNumAttr(InData, FName(TEXT("seed")), 0.0);
			Seed.Attrs.Add(TEXT("seed"), FAttr::MakeNum((double)SeedVal));
		}

		FPlacementPlan Plan;
		ExpandGrammar(Seed, Prods, Plan);

		// ---- Source bore width/height ONCE from the seed so the shell build, the
		// column lateral offset, and the clearance guard all agree on the same w/h.
		// (Avoids three independent literals silently diverging.)
		auto SeedNum = [&](const TCHAR* Key, double Fallback) -> double
		{
			const FAttr* A = Seed.Attrs.Find(Key);
			return (A && A->Type == FAttr::EType::Number) ? A->Num : Fallback;
		};
		const double BoreW = SeedNum(TEXT("w"), 1.8); // metres
		const double BoreH = SeedNum(TEXT("h"), 2.4); // metres
		const double BoreWcm = BoreW * 100.0;
		const double BoreHcm = BoreH * 100.0;
		const double BoreHalfWcm = BoreW * 0.5 * 100.0; // bore half-width (cm)

		// ---- Frame helper (shared by shell + along-edge point placement).
		// X=tangent, Y=right, Z=up. Distance D is in UE units (cm).
		auto Frame = [&](double D, FVector& Loc, FVector& Right, FVector& Up, FVector& Tan)
		{
			const float A = (float)FMath::Clamp(D / TotalLen, 0.0, 1.0);
			const FTransform T = Spline->GetTransformAtAlpha(A);
			Loc = T.GetLocation();
			Right = T.GetUnitAxis(EAxis::Y);
			Up = T.GetUnitAxis(EAxis::Z);
			Tan = T.GetUnitAxis(EAxis::X);
		};

		// ====================================================================
		// SHELL MESH (walls + bent vent). Reuses the proven tunnel winding.
		// ====================================================================
		FDynamicMesh3 Mesh;
		Mesh.EnableAttributes();
		Mesh.Attributes()->EnableMaterialID();
		Mesh.Attributes()->SetNumUVLayers(1);
		bool bAnyShell = false;

		// AddQuad: UE-correct winding so the front face points toward ND.
		auto AddQuad = [&](const FVector& P0, const FVector& P1, const FVector& P2, const FVector& P3, const FVector& ND)
		{
			const int32 A = Mesh.AppendVertex(FVector3d(P0));
			const int32 B = Mesh.AppendVertex(FVector3d(P1));
			const int32 C = Mesh.AppendVertex(FVector3d(P2));
			const int32 Dd = Mesh.AppendVertex(FVector3d(P3));
			const FVector3d g = (FVector3d(P1) - FVector3d(P0)).Cross(FVector3d(P2) - FVector3d(P0));
			if (g.Dot(FVector3d(ND)) < 0)
			{
				Mesh.AppendTriangle(FIndex3i(A, B, C));
				Mesh.AppendTriangle(FIndex3i(A, C, Dd));
			}
			else
			{
				Mesh.AppendTriangle(FIndex3i(A, C, B));
				Mesh.AppendTriangle(FIndex3i(A, Dd, C));
			}
		};

		// AddSection: 4 welded inner walls for a constant-size run [DStart,DEnd].
		// Copied verbatim (winding-wise) from the tunnel node. W/H in UE units (cm).
		// Material IDs: floor (w=0) + ceiling (w=1) -> 0; left (w=2) + right (w=3) -> 1.
		// UVs: U = spline distance / 100 (metres along), V = cross-distance / 100.
		auto AddSection = [&](double DStart, double DEnd, double W, double H)
		{
			const double Spacing = 60.0; // cm ring spacing (matches tunnel default)
			const double hw = W * 0.5;
			const int32 N = FMath::Max(1, FMath::CeilToInt((DEnd - DStart) / Spacing));
			const double Walls[4][6] = {
				{ -hw, 0, hw, 0, +1, 0 }, // floor   -> +up
				{ -hw, H, hw, H, -1, 0 }, // ceiling -> -up
				{ -hw, 0, -hw, H, +1, 1 }, // left    -> +right
				{  hw, 0,  hw, H, -1, 1 }  // right   -> -right
			};
			FDynamicMeshUVOverlay*         UVOv    = Mesh.Attributes()->PrimaryUV();
			FDynamicMeshMaterialAttribute* MatAttr = Mesh.Attributes()->GetMaterialID();
			for (int32 w = 0; w < 4; ++w)
			{
				const int32 MatId = (w <= 1) ? 0 : 1; // floor+ceil=0, left+right=1
				int32 prevA = -1, prevB = -1;
				int32 prevUVA = -1, prevUVB = -1;
				for (int32 i = 0; i <= N; ++i)
				{
					const double D = DStart + (DEnd - DStart) * (double)i / (double)N;
					FVector Loc, R, U, Tn; Frame(D, Loc, R, U, Tn);
					const FVector P0 = Loc + R * Walls[w][0] + U * Walls[w][1];
					const FVector P1 = Loc + R * Walls[w][2] + U * Walls[w][3];
					const int32 A = Mesh.AppendVertex(FVector3d(P0));
					const int32 B = Mesh.AppendVertex(FVector3d(P1));
					// UV: U = distance along spline (cm -> metres), V = 0 for P0, cross-width/100 for P1
					const float UCoord  = (float)(D / 100.0);
					const float VCoordA = 0.0f;
					const float VCoordB = (float)(FVector::Dist(P0, P1) / 100.0);
					const int32 uvA = UVOv->AppendElement(FVector2f(UCoord, VCoordA));
					const int32 uvB = UVOv->AppendElement(FVector2f(UCoord, VCoordB));
					if (i > 0)
					{
						const FVector ND = (Walls[w][5] == 0) ? (U * Walls[w][4]) : (R * Walls[w][4]);
						const FVector3d p0 = Mesh.GetVertex(prevA), p1 = Mesh.GetVertex(A), p2 = Mesh.GetVertex(B);
						const FVector3d g = (p1 - p0).Cross(p2 - p0);
						int32 t0, t1;
						if (g.Dot(FVector3d(ND)) < 0)
						{
							t0 = Mesh.AppendTriangle(FIndex3i(prevA, A, B));
							t1 = Mesh.AppendTriangle(FIndex3i(prevA, B, prevB));
							if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(prevUVA, uvA, uvB)); MatAttr->SetValue(t0, MatId); }
							if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(prevUVA, uvB, prevUVB)); MatAttr->SetValue(t1, MatId); }
						}
						else
						{
							t0 = Mesh.AppendTriangle(FIndex3i(prevA, B, A));
							t1 = Mesh.AppendTriangle(FIndex3i(prevA, prevB, B));
							if (t0 >= 0) { UVOv->SetTriangle(t0, FIndex3i(prevUVA, uvB, uvA)); MatAttr->SetValue(t0, MatId); }
							if (t1 >= 0) { UVOv->SetTriangle(t1, FIndex3i(prevUVA, prevUVB, uvB)); MatAttr->SetValue(t1, MatId); }
						}
					}
					prevA = A; prevB = B;
					prevUVA = uvA; prevUVB = uvB;
				}
			}
		};

		// AddVentTube: a short straight tube riding up from the ceiling, then a bend
		// at BendAtM (metres). Built as a box-section tube along an up+forward path so
		// it welds (shares world space) into the shell. Faces inward (toward axis).
		auto AddVentTube = [&](double AtAlpha, double BendAtM)
		{
			// Anchor: ceiling centre at AtAlpha. Lift to the shell ceiling (seed h)
			// so the shaft springs from the top of the bore, not the floor centreline.
			FVector Loc, R, U, Tn; Frame(AtAlpha * TotalLen, Loc, R, U, Tn);
			const double VentW = 120.0;          // cm, square-ish shaft
			const double CeilingCm = BoreHcm;     // shell H (sourced from seed h)
			const double BendCm = FMath::Clamp(BendAtM, 0.5, kMaxStraightRunM) * 100.0;
			const FVector Base  = Loc + U * CeilingCm;   // mouth at the ceiling
			const FVector PApex = Base + U * BendCm;     // bend point
			const FVector PEnd  = PApex + Tn * BendCm;   // far (capped) end
			const double h = VentW * 0.5;

			// Three cross-section rings, each 4 verts appended ONCE. The vertical and
			// horizontal legs reference the SAME miter-ring indices, so the elbow is
			// connected BY CONSTRUCTION -- no reliance on FMergeCoincidentMeshEdges,
			// which won't fuse the same-oriented seam edges a positional miter produces.
			// Corner order is consistent around the tube so wall k spans corners k..k+1
			// on both rings. base k -> miter k -> end k map by (R sign, in-plane sign):
			//   k0:(-R,near) k1:(+R,near) k2:(+R,far) k3:(-R,far)
			const FVector Inner = U * h + Tn * h;       // inner (concave) corner offset
			const FVector BaseRing[4] = {               // R/Tn plane (vertical leg, OPEN mouth)
				Base + R*-h + Tn*-h, Base + R* h + Tn*-h, Base + R* h + Tn* h, Base + R*-h + Tn* h };
			const FVector MiterRing[4] = {              // shared fold loop (the miter)
				PApex - Inner + R*-h, PApex - Inner + R* h, PApex + Inner + R* h, PApex + Inner + R*-h };
			const FVector EndRing[4] = {                // R/U plane (horizontal leg)
				PEnd + R*-h + U*-h, PEnd + R* h + U*-h, PEnd + R* h + U* h, PEnd + R*-h + U* h };

			int32 B[4], M[4], E[4];
			for (int32 k = 0; k < 4; ++k)
			{
				B[k] = Mesh.AppendVertex(FVector3d(BaseRing[k]));
				M[k] = Mesh.AppendVertex(FVector3d(MiterRing[k]));
				E[k] = Mesh.AppendVertex(FVector3d(EndRing[k]));
			}

			// Uniform tube winding. Wall k spans corner k..n on a (near,far) ring pair.
			// Because the three rings share corner ordering with NO twist (verified: each
			// k keeps its R sign and flows its in-plane sign Base->Miter->End), winding
			// every wall with the SAME scheme makes the whole bent tube consistently
			// orientable -- which CheckValidity's default options require. A single flip
			// (decided from wall 0, the -Tn wall, which must face inward +Tn) orients all
			// walls into the bore. Both ends stay OPEN: the Base mouth into the bore and
			// the far mouth venting to the surface.
			const FVector3d gTest = (FVector3d(BaseRing[1]) - FVector3d(BaseRing[0]))
				.Cross(FVector3d(MiterRing[1]) - FVector3d(BaseRing[0]));
			const bool bFlip = gTest.Dot(FVector3d(Tn)) < 0.0;
			FDynamicMeshUVOverlay*         VentUVOv    = Mesh.Attributes()->PrimaryUV();
			FDynamicMeshMaterialAttribute* VentMatAttr = Mesh.Attributes()->GetMaterialID();
			// Vent walls are all slot 1 (wall material). UVs are flat (0,0) — acceptable
			// for a small vent shaft; the material tint is what matters.
			auto Wall = [&](int32 a0, int32 a1, int32 b1, int32 b0) // near a0..a1, far b0..b1
			{
				// Append UV elements — all (0,0) flat for vent tris.
				const int32 uv0 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv1 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv2 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				const int32 uv3 = VentUVOv->AppendElement(FVector2f(0.0f, 0.0f));
				int32 t0, t1;
				if (!bFlip)
				{
					t0 = Mesh.AppendTriangle(FIndex3i(a0, a1, b1));
					t1 = Mesh.AppendTriangle(FIndex3i(a0, b1, b0));
					if (t0 >= 0) { VentUVOv->SetTriangle(t0, FIndex3i(uv0, uv1, uv2)); VentMatAttr->SetValue(t0, 1); }
					if (t1 >= 0) { VentUVOv->SetTriangle(t1, FIndex3i(uv0, uv2, uv3)); VentMatAttr->SetValue(t1, 1); }
				}
				else
				{
					t0 = Mesh.AppendTriangle(FIndex3i(a0, b1, a1));
					t1 = Mesh.AppendTriangle(FIndex3i(a0, b0, b1));
					if (t0 >= 0) { VentUVOv->SetTriangle(t0, FIndex3i(uv0, uv2, uv1)); VentMatAttr->SetValue(t0, 1); }
					if (t1 >= 0) { VentUVOv->SetTriangle(t1, FIndex3i(uv0, uv3, uv2)); VentMatAttr->SetValue(t1, 1); }
				}
			};
			for (int32 k = 0; k < 4; ++k)
			{
				const int32 n = (k + 1) % 4;
				Wall(B[k], B[n], M[n], M[k]); // vertical-leg wall, base -> miter
				Wall(M[k], M[n], E[n], E[k]); // horizontal-leg wall, miter -> end
			}

			bAnyShell = true;
		};

		// ====================================================================
		// POINT OUTPUT (columns + rubble). Staged into a UPCGBasePointData.
		// ====================================================================
		struct FStagedPoint
		{
			FTransform Xform;
			bool bHasMesh = false;
			FSoftObjectPath MeshPath;
		};
		TArray<FStagedPoint> StagedPoints;

		// ---- Walk the placement plan and realize each item.
		for (const FPlacedItem& Item : Plan.Items)
		{
			if (Item.Kind == TEXT("asset") && Item.Role == TEXT("column"))
			{
				// N = floor(len / spacing). len is metres on the symbol; spacing_m on op.
				const double SpacingM = Item.Op.bHasSpacing && Item.Op.SpacingM > KINDA_SMALL_NUMBER ? Item.Op.SpacingM : 3.0;
				const int32 NCols = FMath::FloorToInt(LenMetres / SpacingM);
				if (NCols <= 0)
				{
					continue;
				}
				const double HalfWcm = (BoreW * 0.5 - 0.1) * 100.0; // (w/2 - 0.1) m -> cm; w sourced from seed
				for (int32 i = 0; i < NCols; ++i)
				{
					const double Alpha = (double)i / (double)NCols;
					const FTransform T = Spline->GetTransformAtAlpha((float)FMath::Clamp(Alpha, 0.0, 1.0));
					const FVector Y = T.GetUnitAxis(EAxis::Y);
					const double Side = (i % 2 == 0) ? +1.0 : -1.0; // alternate
					const FVector Up = T.GetUnitAxis(EAxis::Z);
					// Floor-to-ceiling pillar: scale the unit cube to a slender column the
					// full bore height and lift its centre to mid-height so it stands on the
					// floor instead of sitting half-buried as a 1 m cube.
					FTransform Out = T;
					Out.SetLocation(T.GetLocation() + Y * (Side * HalfWcm) + Up * (BoreHcm * 0.5));
					Out.SetScale3D(FVector(0.45, 0.45, BoreHcm / 100.0));
					FStagedPoint SP;
					SP.Xform = Out;
					if (!ColumnMeshPath.IsNull())
					{
						SP.bHasMesh = true;
						SP.MeshPath = ColumnMeshPath;
					}
					StagedPoints.Add(SP);
				}
			}
			else if (Item.Kind == TEXT("scatter") && Item.Tag == TEXT("rubble"))
			{
				// Sample points along a Phase-IV sub-range of the spline (the back
				// quarter — the "decay" tail). Round-robin the 6 rubble meshes; z=0
				// (floor); deterministic yaw + tiny pitch/roll. NO FMath::Rand.
				const double RangeStart = 0.75; // Phase-IV sub-range
				const double RangeEnd = 1.0;
				const double SubLenM = LenMetres * (RangeEnd - RangeStart);
				const double ScatterSpacingM = 2.0;
				const int32 NScatter = FMath::Max(1, FMath::FloorToInt(SubLenM / ScatterSpacingM));
				for (int32 i = 0; i < NScatter; ++i)
				{
					const double T01 = (NScatter > 1) ? (double)i / (double)(NScatter - 1) : 0.0;
					const double Alpha = RangeStart + (RangeEnd - RangeStart) * T01;
					const FTransform T = Spline->GetTransformAtAlpha((float)FMath::Clamp(Alpha, 0.0, 1.0));

					// Deterministic jitter from (production index + point index).
					const double UYaw   = DeterministicUnit(Item.SymbolKind, Item.Index, i);
					const double UPitch = DeterministicUnit(Item.SymbolKind, Item.Index, i + 7919);
					const double URoll  = DeterministicUnit(Item.SymbolKind, Item.Index, i + 104729);
					const double Yaw   = UYaw * 360.0;          // full yaw spread
					const double Pitch = (UPitch * 2.0 - 1.0) * 3.0; // +/-3 deg
					const double Roll  = (URoll  * 2.0 - 1.0) * 3.0; // +/-3 deg

					// Deterministic lateral spread across the floor so rubble does not
					// stack down the centreline. Keep |LatU| inside the walls (bore
					// half-width minus a 30 cm margin). z=0: the spline transform already
					// sits on the floor centreline, so we only offset along right (Y).
					const double ULat = DeterministicUnit(Item.SymbolKind, Item.Index, i + 200);
					const double LatU = (ULat * 2.0 - 1.0) * FMath::Max(0.0, BoreHalfWcm - 30.0);
					FTransform Out;
					Out.SetLocation(T.GetLocation() + T.GetUnitAxis(EAxis::Y) * LatU);
					Out.SetRotation(FRotator(Pitch, Yaw, Roll).Quaternion());
					Out.SetScale3D(FVector(1.0));

					FStagedPoint SP;
					SP.Xform = Out;
					SP.bHasMesh = true;
					SP.MeshPath = FSoftObjectPath(GRubbleMeshPaths[i % kNumRubble]);
					StagedPoints.Add(SP);
				}
			}
			else if (Item.Kind == TEXT("shell") && Item.Role == TEXT("wall"))
			{
				// Arched/curved inner shell along the full spline. Reuse the tunnel
				// section winding. W/H sourced once from the seed (metres -> cm).
				AddSection(0.0, TotalLen, BoreWcm, BoreHcm);
				bAnyShell = true;
			}
			else if (Item.Kind == TEXT("shell") && Item.Role == TEXT("vent"))
			{
				// Child shaft: short straight tube then a bend at bend_at_m, welded in.
				const double BendAtM = Item.Op.bHasBendAt ? Item.Op.BendAtM : kMaxStraightRunM;
				AddVentTube(0.5, BendAtM); // mid-run vent
			}
			else if (Item.Kind == TEXT("decal") || Item.Kind == TEXT("fill"))
			{
				// TODO(vertical-slice): decal + fill emits are no-ops for now. A full
				// implementation would project decals along the spline (decal.along)
				// and fill voids at attachment points (fill.at). Out of scope here.
			}
			// Unknown emit kinds: ignored (the slice covers the contract's geometry ops).
		}

		// ---- Emit the SHELL dynamic mesh (one per input spline) if anything built.
		if (bAnyShell && Mesh.TriangleCount() > 0)
		{
			// Weld co-located edges: AppendVertex never merges duplicates, so the
			// per-quad/per-ring vertices (shell walls, vent legs, elbow bridge) sit
			// on top of each other but are topologically separate. Merge coincident
			// edges so the shell + vent form one welded surface before normals.
			FMergeCoincidentMeshEdges Welder(&Mesh);
			Welder.Apply();

			FMeshNormals::QuickRecomputeOverlayNormals(Mesh);

			UPCGDynamicMeshData* ShellData = FPCGContext::NewObject_AnyThread<UPCGDynamicMeshData>(Context);
			// Slot 0 = floor/ceiling material; Slot 1 = wall material (same assets as room).
			UMaterialInterface* FCMat   = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomFloorCeil.MI_RoomFloorCeil")));
			UMaterialInterface* WallMat = Cast<UMaterialInterface>(StaticLoadObject(UMaterialInterface::StaticClass(), nullptr, TEXT("/Game/Hayba/Generated/Mat/MI_RoomWall.MI_RoomWall")));
			TArray<UMaterialInterface*> TunnelMats;
			TunnelMats.Add(FCMat   ? FCMat   : ShellMat); // slot 0: floor + ceiling
			TunnelMats.Add(WallMat ? WallMat : ShellMat); // slot 1: walls
			ShellData->Initialize(MoveTemp(Mesh), TunnelMats);

			FPCGTaggedData& OutShell = Context->OutputData.TaggedData.Emplace_GetRef();
			OutShell.Data = ShellData;
			OutShell.Pin = FName(TEXT("Shell"));
			OutShell.Tags = In.Tags;
		}

		// ---- Emit POINTS (columns + rubble) on the default Out pin.
		if (StagedPoints.Num() > 0)
		{
			UPCGBasePointData* OutPointData = FPCGContext::NewPointData_AnyThread(Context);
			check(OutPointData);

			const int32 N = StagedPoints.Num();
			OutPointData->SetNumPoints(N, /*bInitializeValues=*/false);
			// Allocate Transform + MetadataEntry (we write a per-point mesh attribute).
			OutPointData->AllocateProperties(EPCGPointNativeProperties::Transform | EPCGPointNativeProperties::MetadataEntry);

			// Per-point mesh attribute (FSoftObjectPath) for MeshSelectorByAttribute.
			FPCGMetadataAttribute<FSoftObjectPath>* MeshAttr = nullptr;
			if (OutPointData->Metadata)
			{
				MeshAttr = OutPointData->Metadata->FindOrCreateAttribute<FSoftObjectPath>(
					kMeshAttributeName, FSoftObjectPath(), /*bAllowsInterpolation=*/false, /*bOverrideParent=*/true);
			}

			FPCGPointValueRanges OutRanges(OutPointData, /*bAllocate=*/false);
			for (int32 i = 0; i < N; ++i)
			{
				const FStagedPoint& SP = StagedPoints[i];
				FPCGPoint OutPoint;
				OutPoint.Transform = SP.Xform;
				if (OutPointData->Metadata)
				{
					OutPointData->Metadata->InitializeOnSet(OutPoint.MetadataEntry);
					if (MeshAttr && SP.bHasMesh)
					{
						MeshAttr->SetValue(OutPoint.MetadataEntry, SP.MeshPath);
					}
				}
				OutRanges.SetFromPoint(i, OutPoint);
			}

			FPCGTaggedData& OutPts = Context->OutputData.TaggedData.Emplace_GetRef();
			OutPts.Data = OutPointData;
			OutPts.Pin = PCGPinConstants::DefaultOutputLabel;
			OutPts.Tags = In.Tags;
		}
	}

	return true;
}

#undef LOCTEXT_NAMESPACE
