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

namespace HaybaUIOps
{
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
}
