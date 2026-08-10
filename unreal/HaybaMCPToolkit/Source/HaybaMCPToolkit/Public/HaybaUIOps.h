#pragma once

// Wire-format concerns for the UI domain, separated from widget editing.
//
// HaybaMCPUIHandler is the largest handler in the plugin (3,100+ lines) and its
// commands interleave three unrelated jobs in one function body: what the wire
// said, what the widget tree needs, and what the reply should look like. The
// first of those is pure, and pure code can be tested without an editor.
//
// This is the UI domain's equivalent of HaybaActorOps.h, starting with the piece
// that has already cost the most: payload naming. See #320.

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "HaybaMCPParams.h"

namespace HaybaUIOps
{
    // ── WidgetBlueprint variable-GUID invariant ───────────────────────────
    //
    // UE's WidgetBlueprintCompiler requires one valid, unique GUID for every
    // source widget and animation. Once the map is non-empty, a missing or stale
    // entry emits ensureAlways from the compiler. Planning the exact map is pure
    // so every mutation path can share one rule and the crash shapes can be
    // regression-tested without compiling a damaged asset.

    struct FVariableGuidReconciliation
    {
        TMap<FName, FGuid> Reconciled;
        TArray<FName> Missing;
        TArray<FName> Stale;
        TArray<FName> Invalid;
        TArray<FName> Colliding;
        TArray<FName> DuplicateSourceNames;
        TArray<FName> ScratchSourceNames;
        bool bChanged = false;

        /** Duplicate source names and leaked staging/trash names cannot be
         *  repaired by changing the GUID map: compilation must be refused. */
        bool CanApply() const
        {
            return DuplicateSourceNames.IsEmpty() && ScratchSourceNames.IsEmpty();
        }

        int32 RepairCount() const
        {
            return Missing.Num() + Stale.Num() + Invalid.Num() + Colliding.Num();
        }

        FString BlockingReason() const;
        FString RepairSummary() const;
    };

    /** Return the exact compiler-safe map, preserving every usable GUID.
     *
     *  `SourceNames` must contain every source widget AND animation, matching
     *  UWidgetBlueprint::ForEachSourceWidget plus Animations. Missing, invalid,
     *  colliding and stale entries are repaired deterministically. Duplicate or
     *  scratch source names are blockers because a map cannot make those object
     *  identities unambiguous. */
    FVariableGuidReconciliation PlanVariableGuidReconciliation(
        const TArray<FName>& SourceNames,
        const TMap<FName, FGuid>& Existing);

    /** Where a slot-properties payload was found, so the reply can say. */
    enum class ESlotPropsSpelling : uint8
    {
        None,
        SlotProps,       // `slot_props`      — the public schema
        SlotProperties,  // `slot_properties` — an early handler revision
        SlotLayout,      // `slot_layout`     — the typed slot tool
    };

    struct FSlotPropsPayload
    {
        TSharedPtr<FJsonObject> Object;
        ESlotPropsSpelling Spelling = ESlotPropsSpelling::None;

        bool IsSet() const { return Object.IsValid(); }
    };

    /** Find the slot-properties object under any of its three shipped names.
     *
     *  Three spellings exist because three layers were written at different
     *  times, and only `slot_props` was ever read. The typed slot tool's payload
     *  therefore fell on the floor and the call failed with "no properties
     *  provided" no matter how well-formed it was — a request that was entirely
     *  correct, rejected for using the name its own tool sends.
     *
     *  Precedence is public schema first, then the older spellings, so a caller
     *  sending both gets the documented one. Pure: no editor, no widget tree. */
    FSlotPropsPayload ResolveSlotProps(const TSharedPtr<FJsonObject>& Params);

    /** The name a spelling came in under, for the response. An agent that sent a
     *  deprecated spelling should be told which one it used rather than left to
     *  infer that it worked by accident. */
    const TCHAR* SpellingName(ESlotPropsSpelling Spelling);

    // ── ui_set_widget_properties ─────────────────────────────────────────────
    //
    // Same three-way split as HaybaActorOps.h — Parse / Execute / Shape — with
    // one difference: Execute stays in the handler. Applying properties needs
    // the widget tree, UMG slot classes, Modify()/PostEditChange() and
    // FBlueprintEditorUtils, none of which this header should drag in. Parse and
    // Shape are the halves that are pure, and they are the halves that were
    // wrong: the payload-naming bug and the counter that credited a success per
    // *submitted* key rather than per applied one both lived here.

    struct FSetPropertiesRequest
    {
        FString BlueprintPath;
        FString WidgetName;
        /** Widget properties. Null when the caller sent none — which is not the
         *  same as an empty object, though both mean "nothing to apply". */
        TSharedPtr<FJsonObject> Properties;
        FSlotPropsPayload Slot;

        /** Whether there is a single key to write. A request naming a widget and
         *  carrying no keys used to reach the editor, mark the blueprint dirty
         *  and come back "nothing applied ... Rejected: " with an empty list. */
        bool HasAnythingToApply() const;
    };

    struct FSetPropertiesResult
    {
        FString WidgetName;
        /** Keys the widget or its slot actually took. Not the count submitted:
         *  slot keys used to be counted as successes before the slot was asked
         *  whether it understood them. */
        int32 Succeeded = 0;
        int32 Failed = 0;
        TArray<FString> FailedProps;
        TArray<FString> UnknownSlotProps;
        TArray<FString> Warnings;
        /** Which spelling the slot payload arrived under, so the reply can name
         *  a deprecated one instead of forgiving it in silence. */
        ESlotPropsSpelling SlotSpelling = ESlotPropsSpelling::None;

        bool AppliedNothing() const { return Succeeded == 0; }
    };

    /** 1. Parse — pure. Errors accumulate on the reader; check R.HasErrors().
     *
     *  "You sent no keys" is decided here rather than after the blueprint loads,
     *  so a caller with two mistakes hears about both at once instead of being
     *  told about the blueprint and then, a round trip later, about the payload. */
    FSetPropertiesRequest ParseSetProperties(FHaybaParamReader& R);

    /** How a slot key is named in `failed_properties`, so widget and slot keys
     *  cannot be confused with each other in a flat list. */
    FString SlotKeyName(const FString& Key);

    /** 3. Shape — pure. */
    TSharedPtr<FJsonObject> ShapeSetProperties(const FSetPropertiesResult& Result);

    /** The message for a request where nothing landed. Naming the rejected keys
     *  is the difference between "your property names are wrong" and a bare
     *  failure the caller can only respond to by guessing. */
    FString NothingAppliedError(const FSetPropertiesResult& Result);
}
