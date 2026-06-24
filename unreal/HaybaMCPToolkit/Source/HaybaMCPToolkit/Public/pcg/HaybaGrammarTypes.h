#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "PCGData.h"
#include "Metadata/PCGMetadata.h"
#include "Metadata/PCGMetadataAttributeTpl.h"

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
	inline FAttr JsonValueToAttr(const TSharedPtr<FJsonValue>& V)
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
	inline bool AttrStrictEquals(const FAttr* SymAttr, const TSharedPtr<FJsonValue>& WhenVal)
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
	inline bool AttrGreaterThan(const FAttr* SymAttr, const TSharedPtr<FJsonValue>& WhenVal)
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
	inline bool WhenMatches(const FSymbol& Sym, const TArray<FWhenClause>& When)
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
	inline bool ParseEmitOp(const TSharedPtr<FJsonObject>& Obj, FEmitOp& Out)
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
	inline void ParseGrammar(const TSharedPtr<FJsonObject>& Root, TArray<FProduction>& OutProds)
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
	inline FString ReadStrAttr(const UPCGData* Data, FName Name, const FString& Default)
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

	inline double ReadNumAttr(const UPCGData* Data, FName Name, double Default)
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
	inline void MatchProductions(const FSymbol& Sym, const TArray<FProduction>& Prods, TArray<const FProduction*>& Out)
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
	inline EJunctionType JunctionTypeFor(const FString& A, const FString& B)
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

	inline bool GuardIdIsClearance(const FString& Id)
	{
		return Id.Contains(TEXT("clearance"));
	}
	inline bool GuardIdIsStraightRun(const FString& Id)
	{
		return Id.Contains(TEXT("max_straight_run")) || Id.Contains(TEXT("no_straight_air"));
	}

	// EvalGuards: ops + sym describe the production being tried.
	// Returns hardFail when a structural guard cannot be satisfied.
	inline FGuardVerdict EvalGuards(const TArray<FString>& Guards, const TArray<FEmitOp>& Ops, const FSymbol& Sym)
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

	inline void ExpandGrammar(const FSymbol& Seed, const TArray<FProduction>& Prods, FPlacementPlan& Plan)
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
