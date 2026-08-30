# Hayba extension — visual system brief

## Context
Hayba is an Unreal Engine 5 editor plugin: an AI agent that authors 3D worlds.
Its UI is Slate, docked inside the Unreal Editor (dark neutral grey chrome).
The plugin is being redesigned from 11 implementation-named tabs down to
5 intent-named ones.

## Fixed constraints (do not change)
- The LOGO STAYS AS IS. `Resources/HaybaLogo.svg` — a hay-store/hut silhouette,
  cream `#DED4C3` body, ochre `#B56A1D` banded roof, small spark motif above.
  Do not redraw, restyle, or "modernise" the logo. New work must sit beside it.
- Product name stays "Hayba".
- Icons render at 28x28 px in the sidebar, and 16x16 inline. They must be
  legible at BOTH sizes on a dark background.

## Direction (decided)
Cool neutral chrome + ochre spent ONLY on meaning.

- The UI ground is cool/neutral so it sits correctly inside Unreal's chrome.
- `#B56A1D` ochre (or a legibility-tuned variant — you may propose one, state
  the hex and the reason) is reserved for SEMANTICS: active tab, pending
  approval, unsaved edit, rule violation needing attention. It is NEVER
  decoration. If a shape is ochre, it means something.
- This solves two current failures: the icon set has no state system at all
  (every icon is a single flat `#FEE7C7`), and the product currently runs two
  fighting palettes (warm logo + warm icons vs cool blue-grey text styles).

## Icon system rules
- ONE 24x24 keyline grid. Every icon drawn on it. Common padding: 2px safe
  margin, so live area is 20x20.
- ONE weight. Pick a stroke width (recommend 1.75–2px at 24 grid) and hold it
  across the entire set. Current set is all solid fills of arbitrary density —
  that is the bug being fixed.
- Consistent optical mass. An icon of 9 scattered dots and an icon that is one
  filled slab cannot sit in the same sidebar. Normalise perceived weight.
- Two-tone capable: each icon is authored so a single "state layer" path can be
  tinted ochre independently of the base. Use two groups: `<g id="base">` and
  `<g id="state">`. State group may be empty for icons with no state.
- Output: clean SVG, `viewBox="0 0 24 24"`, no filters, no embedded raster, no
  `<defs>` unless genuinely needed, `currentColor` for base where possible.
- No drop shadows. Slate renders these small; shadows turn to mud.

## Palette to define
Propose and document a complete token set as `palette.md`:
- surface levels (panel / raised / sunken), border/line, 3 text levels
- the semantic ochre + its hover/pressed variants
- a minimal status triad (pass / attention / fail). Keep it restrained —
  ochre should carry "attention", so pass and fail need to not shout.
Give every token a hex and a one-line "use this when…".

## Icons required (13)

Sidebar (5 nouns + gear):
1. `world`    — the understood scene. Spatial/terrain grounding, a cognitive map.
2. `library`  — things you can place or apply (Profiles + Recipes).
3. `rules`    — what must be true about the world. Constraints with a verdict.
4. `activity` — a timeline of what the agent proposed, did, and changed.
5. `chat`     — talking to the agent.
6. `settings` — gear.

Semantic / inline:
7.  `profile`       — what a single asset IS (baked geometry + semantics).
8.  `recipe`        — a parameterized, repeatable edit.
9.  `rule-pass`     — constraint satisfied.
10. `rule-violated` — constraint violated, with direction to fix. (ochre)
11. `plan-pending`  — awaiting human approval. (ochre)
12. `diff`          — before/after of a change.
13. `undo`          — revert a transaction.

Avoid clichés: no generic gear-for-everything, no floppy disk, no lightbulb,
no robot head, no magic wand, no sparkles-mean-AI.

The set should feel like it belongs with a hay-store logo — grounded,
constructed, slightly agrarian-geometric — WITHOUT any icon literally
depicting hay, barns, or farms. Think: built structure, strata, plotted land,
survey marks. Restraint over whimsy.

## Deliverables
Write into `docs/design/2026-08-23-extension-redesign/`:
- `icons/<name>.svg` for all 13
- `palette.md` — the token set
- `icons/preview.html` — a self-contained dark page showing every icon at
  28px and 16px, in base and ochre-state form, on the actual proposed surface
  colours, plus a mock sidebar strip so optical weight can be compared.
- `RATIONALE.md` — short. What weight/grid you chose, what ochre hex and why,
  and any icon where you deviated from the brief and what forced it.
