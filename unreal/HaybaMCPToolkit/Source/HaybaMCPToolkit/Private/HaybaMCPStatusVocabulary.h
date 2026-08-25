#pragma once

#include "CoreMinimal.h"
#include "Styling/SlateColor.h"

/**
 * The one status vocabulary.
 *
 * The IA asks for exactly this, and names the colours:
 *
 *   "Use one consistent status set across Activity, inline Chat cards, and
 *    Library run results:
 *      running        -- work is streaming; blue-neutral status.
 *      needs approval -- Plan Mode pause; semantic ochre.
 *      done           -- completed; restrained green.
 *      needs attention-- a rule has a negative margin; semantic ochre plus Fix.
 *      error          -- tool or connection failure; restrained red, with the
 *                        returned error text."
 *
 * The tokens for all five already existed -- Status.Info is the blue-neutral,
 * Status.Pass the restrained green, Status.Fail the restrained red, and
 * Accent.Ochre the semantic ochre. Nothing consumed them. Every panel invented
 * its own instead, and the Plan panel went further and hardcoded literal
 * floats, including an "accent" that is a different colour from the product's
 * ochre.
 *
 * So this is a seam, not a new design: one enum, one label, one colour, one
 * glyph, resolved from the style tokens. A panel that needs a status asks here.
 */
enum class EHaybaStatus : uint8
{
    /** Work is streaming. */
    Running,
    /** Plan Mode pause -- the user has to say yes. */
    NeedsApproval,
    /** Completed. */
    Done,
    /** A rule has a negative margin; pairs with a Fix affordance. */
    NeedsAttention,
    /** Tool or connection failure. Show the returned error text with it. */
    Error,

    /**
     * Not one of the IA's five, and deliberately named so it cannot be
     * mistaken for one: a step that has not started yet.
     *
     * The IA's set describes work that is happening or has happened. A plan
     * lists steps before any of them run, and calling those "needs approval"
     * would claim the user has something to decide about each one. Kept
     * separate rather than folded in, so the five stay honest.
     */
    NotStarted,
};

namespace HaybaStatus
{
    /** The IA's wording, verbatim. Lowercase because that is how the IA
     *  writes them and how they read in a chip. */
    FText Label(EHaybaStatus Status);

    /** Resolved from the style tokens, never a literal. */
    FSlateColor Colour(EHaybaStatus Status);

    /** A single character, for chips too small for a word. Deliberately not
     *  the only carrier of meaning -- the label and colour go with it. */
    const TCHAR* Glyph(EHaybaStatus Status);

    /** True when the state calls for a Fix affordance beside it. The IA pairs
     *  "needs attention" with Fix specifically; keeping that here means a
     *  panel cannot forget it. */
    bool WantsFixAffordance(EHaybaStatus Status);
}
