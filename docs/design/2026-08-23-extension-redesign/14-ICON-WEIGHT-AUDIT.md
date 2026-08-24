# Icon audit — pixel verification and optical weight

Measured 2026-08-24 by decoding the actual PNGs, not by trusting the
generation notes.

## Verified: the two-tone claim is true

All **37 masters contain zero off-palette opaque pixels** — every solid pixel
is `#DED4C3` or `#C47A28` within tolerance. The palette normalisation did what
it claimed, and the flat two-tone property the set's legibility argument rests
on is real rather than asserted.

Derived rasters carry substantial edge anti-aliasing at both 28 and 16 px
(16–227% of solid-pixel count), so the downscale is doing its job. The masters
having hard edges is correct, not a defect: the resampler is what creates the
anti-aliasing, and starting from hard edges is what keeps it clean.

## Defect: optical weight varies 6.7× across the set

Ink coverage inside the 16×16 cell, ranked. This is the measurable form of
"goes mushy at small size".

| Icon | Solid px / 256 | Solid % | Verdict |
|---|---:|---:|---|
| camera-viewport | 28 | 10.9% | **faint** |
| connect | 28 | 10.9% | **faint** |
| remove | 28 | 10.9% | **faint** |
| state-pending | 36 | 14.1% | **faint** |
| world | 37 | 14.5% | **faint** |
| undo | 40 | 15.6% | **faint** |
| diff | 43 | 16.8% | **faint** |
| recipe | 44 | 17.2% | **faint** |
| search | 45 | 17.6% | **faint** |
| activity | 47 | 18.4% | **faint** |
| *…15 icons in the 23–29% "thin" band…* | | | |
| chat | 111 | 43.4% | ok |
| settings | 132 | 51.6% | ok |
| rule-pass | 139 | 54.3% | ok |
| material | 140 | 54.7% | ok |
| **save** | **187** | **73.0%** | ok |

Median 27.3%. **10 of 37 under 20%.**

A set is supposed to look like one set. `save` at 73% and `connect` at 10.9%
in the same toolbar will not: one reads as bold and present, the other as
faint and provisional. This is a property of the drawn geometry — thin
strokes and lots of internal negative space — so no amount of resampling
fixes it.

Two of the faint ones matter more than the rest: **`world` sits in the sidebar
at 28px** (where it fares better, but is still the lightest noun) and
**`state-pending` is a row-end state mark** whose entire job is to be noticed.

## What this does not mean

It is not a verdict on the shapes. The set was chosen deliberately and the
metaphors survived four rounds of review. This measures *weight*, which is a
separate axis from *meaning* and is fixable without redrawing anything: the
same shapes at heavier stroke and less internal negative space.

## Options, for a human to choose

1. **Regenerate the ten faint icons at heavier weight**, same metaphors, same
   palette. Cheapest fix that preserves every decision already made. Would
   need re-picking only if a heavier draw changes the shape's character.
2. **Restrict the faint icons to 28px** and do not use them inline. Free, but
   it constrains where they can appear, and `state-pending` is inherently a
   16px mark — so this does not solve that one.
3. **Accept the spread.** Defensible if these icons end up used in separated
   contexts rather than side by side, which is not how the wireframes use them.

Recommendation is (1) for the ten under 20%, leaving the 23–29% band alone —
the eye tolerates that much variance, and re-cutting 25 icons to chase
uniformity would risk the shapes for a gain nobody would notice.

**Not acted on.** These are icons the user picked individually across four
review rounds; regenerating them is their call, not a maintenance decision.

## Method

`audit-icons.py` / `audit-coverage.py` in the session scratchpad decode the
PNGs directly (minimal zlib + Paeth-filter reader) and classify pixels by
alpha. Nothing here relies on an image library being installed, and nothing
relies on the generation notes being accurate — which was the point, since the
two-tone claim had been repeated several times without ever being checked.
