# Icon set — revision 2

The v1 set is good on grid, weight, and palette. Keep all of that. One thing
is wrong and it is the thing the whole system was for.

## The defect

11 of the 13 `<g id="state">` layers are the **same generic "+" pip**, merely
repositioned:

```
world         M19 4.5v3 M17.5 6h3
rules         M19 4v3   M17.5 5.5h3
chat          M18.5 4v3 M17 5.5h3
profile       M18.5 4v3 M17 5.5h3
undo          M18.5 4v3 M17 5.5h3
rule-pass     M18.5 4v3 M17 5.5h3
rule-violated M18.5 5v3 M17 6.5h3     <-- worst case
library / recipe / settings / plan-pending — same mark, other corners
```

Three problems:

1. **A plus sign means "add".** It does not mean active, pending, unsaved, or
   violated. The mark is semantically wrong for every state it is supposed to
   carry.
2. **An identical mark on every icon conveys only "something".** The state layer
   was specified so one asset could express *which* state. A uniform pip cannot.
3. **`rule-violated` carries a plus.** Being violated is that icon's entire
   meaning. Its state layer should be the violation, not a decoration.

## The fix

Stop putting a per-icon pip in the corner. Adopt a **shared state vocabulary** of
exactly three marks, drawn identically wherever they appear, so a user learns
three shapes once instead of guessing at thirteen:

- **attention / violated** — a small solid triangle (or a stem+dot exclamation),
  ochre. Means: this needs you.
- **pending** — a small half-filled circle or a two-hand clock tick, ochre.
  Means: waiting on your approval.
- **unsaved / dirty** — a small solid dot, ochre. Means: changed, not committed.

Rules for applying them:

- **Nouns carry no baked-in state mark.** `world`, `library`, `rules`,
  `activity`, `chat`, `settings`, `profile`, `recipe`, `diff`, `undo` ship with
  an **empty** `<g id="state">`. The UI composes the appropriate shared mark over
  them when the state applies. That is what makes the layer reusable.
- **The three semantic icons ARE their state.** `rule-pass`, `rule-violated`,
  `plan-pending` express their meaning in the base geometry — a check, a
  violation, a wait. They must not also wear a redundant corner pip. Give them
  an empty state group too.
- **Active tab is not an icon state.** Per palette.md's own rule, the active
  sidebar row is expressed by `surface.raised` plus the row treatment, not by
  recolouring the icon. Do not encode "active" in the icon at all.

Deliver the three shared marks as their own files so the UI can composite them:

- `icons/state-attention.svg`
- `icons/state-pending.svg`
- `icons/state-unsaved.svg`

each on the same 24x24 grid but drawn small and bottom-right-anchored, so
overlaying one on any noun icon lands correctly without per-icon tuning.

## Also fix

- `RATIONALE.md` claims `rule-violated` uses "a 2.2px exclamation stem". Make
  that true, or remove the claim. Documentation that describes art that is not
  there is exactly the failure mode this whole redesign is correcting.

## Keep unchanged

24x24 viewBox, 2px safe margin, 1.8px rounded stroke, `currentColor` base,
no filters, no raster, the `#C47A28` tuned ochre, the palette tokens, and the
logo.

## Update

Regenerate `icons/preview.html` to show, additionally, each noun icon with each
of the three shared state marks composited over it, so overlay alignment can be
checked at 28px and 16px.
