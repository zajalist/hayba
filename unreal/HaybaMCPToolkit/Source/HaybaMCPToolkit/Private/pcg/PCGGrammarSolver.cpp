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
	Pins.Emplace(PCGPinConstants::DefaultInputLabel, EPCGDataType::Spline);
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

		// ---- Seed symbol: a tunnel run with native-builder phase-I attrs.
		FSymbol Seed;
		Seed.Kind = TEXT("tunnel");
		Seed.Attrs.Add(TEXT("builder"),    FAttr::MakeStr(TEXT("native")));
		Seed.Attrs.Add(TEXT("phase"),      FAttr::MakeStr(TEXT("I")));
		Seed.Attrs.Add(TEXT("importance"), FAttr::MakeNum(0.3));
		Seed.Attrs.Add(TEXT("len"),        FAttr::MakeNum(LenMetres));
		Seed.Attrs.Add(TEXT("w"),          FAttr::MakeNum(1.8));
		Seed.Attrs.Add(TEXT("h"),          FAttr::MakeNum(2.4));

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
			for (int32 w = 0; w < 4; ++w)
			{
				int32 prevA = -1, prevB = -1;
				for (int32 i = 0; i <= N; ++i)
				{
					const double D = DStart + (DEnd - DStart) * (double)i / (double)N;
					FVector Loc, R, U, Tn; Frame(D, Loc, R, U, Tn);
					const FVector P0 = Loc + R * Walls[w][0] + U * Walls[w][1];
					const FVector P1 = Loc + R * Walls[w][2] + U * Walls[w][3];
					const int32 A = Mesh.AppendVertex(FVector3d(P0));
					const int32 B = Mesh.AppendVertex(FVector3d(P1));
					if (i > 0)
					{
						const FVector ND = (Walls[w][5] == 0) ? (U * Walls[w][4]) : (R * Walls[w][4]);
						const FVector3d p0 = Mesh.GetVertex(prevA), p1 = Mesh.GetVertex(A), p2 = Mesh.GetVertex(B);
						const FVector3d g = (p1 - p0).Cross(p2 - p0);
						if (g.Dot(FVector3d(ND)) < 0)
						{
							Mesh.AppendTriangle(FIndex3i(prevA, A, B));
							Mesh.AppendTriangle(FIndex3i(prevA, B, prevB));
						}
						else
						{
							Mesh.AppendTriangle(FIndex3i(prevA, B, A));
							Mesh.AppendTriangle(FIndex3i(prevA, prevB, B));
						}
					}
					prevA = A; prevB = B;
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
			// The vent comment "Faces inward" is honored by the inward ND below.
			FVector Loc, R, U, Tn; Frame(AtAlpha * TotalLen, Loc, R, U, Tn);
			const double VentW = 120.0;          // cm, square-ish shaft
			const double CeilingCm = BoreHcm;     // shell H (sourced from seed h)
			const double BendCm = FMath::Clamp(BendAtM, 0.5, kMaxStraightRunM) * 100.0;
			const FVector Base = Loc + U * CeilingCm; // start at the ceiling
			// Straight leg goes UP (+U) for BendCm, then bends to run along +Tn for BendCm.
			const FVector PApex = Base + U * BendCm;
			const FVector PEnd  = PApex + Tn * BendCm;

			// Cross-section offsets (right/forward plane perpendicular to each leg).
			const double h = VentW * 0.5;
			// Leg 1 (vertical): cross-section spans R and Tn.
			auto Ring1 = [&](const FVector& Centre, FVector& Q0, FVector& Q1, FVector& Q2, FVector& Q3)
			{
				Q0 = Centre + R * -h + Tn * -h;
				Q1 = Centre + R *  h + Tn * -h;
				Q2 = Centre + R *  h + Tn *  h;
				Q3 = Centre + R * -h + Tn *  h;
			};
			// Leg 2 (horizontal along +Tn): cross-section spans R and U.
			auto Ring2 = [&](const FVector& Centre, FVector& Q0, FVector& Q1, FVector& Q2, FVector& Q3)
			{
				Q0 = Centre + R * -h + U * -h;
				Q1 = Centre + R *  h + U * -h;
				Q2 = Centre + R *  h + U *  h;
				Q3 = Centre + R * -h + U *  h;
			};

			FVector A0, A1, A2, A3, B0, B1, B2, B3;
			// Vertical leg walls. ND points INWARD (toward the leg centreline), i.e.
			// the negation of the side each wall's four vertices sit on, matching the
			// shell's front-face-into-the-bore convention. The wall at Tn*-h faces +Tn.
			Ring1(Base,  A0, A1, A2, A3);
			Ring1(PApex, B0, B1, B2, B3);
			AddQuad(A0, A1, B1, B0, (Tn *  1.0)); // -Tn wall -> inward +Tn
			AddQuad(A1, A2, B2, B1, (R * -1.0));  // +R wall  -> inward -R
			AddQuad(A2, A3, B3, B2, (Tn * -1.0)); // +Tn wall -> inward -Tn
			AddQuad(A3, A0, B0, B3, (R *  1.0));  // -R wall  -> inward +R

			// Elbow: weld the vertical leg's apex ring (Ring1@PApex = B0..B3, in the
			// R/Tn plane) to the horizontal leg's start ring (Ring2@PApex, in the R/U
			// plane) with four bridge quads so the mitre is closed, not an open gap.
			// Bridge faces point inward toward the elbow centre PApex.
			FVector E0, E1, E2, E3;             // Ring1 @ PApex (apex of vertical leg)
			FVector F0, F1, F2, F3;             // Ring2 @ PApex (start of horizontal leg)
			Ring1(PApex, E0, E1, E2, E3);
			Ring2(PApex, F0, F1, F2, F3);
			AddQuad(E0, E1, F1, F0, ((PApex - (E0 + E1 + F1 + F0) * 0.25)).GetSafeNormal());
			AddQuad(E1, E2, F2, F1, ((PApex - (E1 + E2 + F2 + F1) * 0.25)).GetSafeNormal());
			AddQuad(E2, E3, F3, F2, ((PApex - (E2 + E3 + F3 + F2) * 0.25)).GetSafeNormal());
			AddQuad(E3, E0, F0, F3, ((PApex - (E3 + E0 + F0 + F3) * 0.25)).GetSafeNormal());

			// Horizontal leg walls. ND inward toward the leg centreline (negation of
			// each wall's side), same convention as the vertical leg.
			Ring2(PApex, A0, A1, A2, A3);
			Ring2(PEnd,  B0, B1, B2, B3);
			AddQuad(A0, A1, B1, B0, (U *  1.0));  // -U wall  -> inward +U
			AddQuad(A1, A2, B2, B1, (R * -1.0));  // +R wall  -> inward -R
			AddQuad(A2, A3, B3, B2, (U * -1.0));  // +U wall  -> inward -U
			AddQuad(A3, A0, B0, B3, (R *  1.0));  // -R wall  -> inward +R

			// Cap the far (top) end of the horizontal leg so it is not an open hole.
			// The end cap at PEnd faces inward (-Tn, back toward the elbow) consistent
			// with the inward-facing wall convention. The Base end is left OPEN so the
			// shaft mouth opens down into the bore at the ceiling penetration.
			AddQuad(B0, B1, B2, B3, (Tn * -1.0));

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
					FTransform Out = T;
					Out.SetLocation(T.GetLocation() + Y * (Side * HalfWcm));
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
			TArray<UMaterialInterface*> ShellMaterials;
			if (ShellMat)
			{
				ShellMaterials.Add(ShellMat);
			}
			ShellData->Initialize(MoveTemp(Mesh), ShellMaterials);

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
