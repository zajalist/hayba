# Icon regen — v3b (6 icons, meaning-first)

Regenerate SIX icons from the v3 set using your AI image generation
(`image_gen` — same pipeline as last run, including the palette-normalization
pass to exact flat `#DED4C3` / `#C47A28` and transparent alpha at 512px).

## Why v3 failed for these six
The v3 prompts led with the style contract, so the model optimized for
pretty-blob over meaning. `activity` and `plan-pending` came out as chess
pawns, `recipe` too, `rules` as a thimble with a stray white band, `profile`
as a vase. **An icon's silhouette must say what it does before the label is
read.** This round, every prompt LEADS with the metaphor, then applies the
style.

## Style contract (unchanged from v3 — apply AFTER the metaphor)
Filled silhouette only, no outlines/strokes/gradients/shadow/texture/3D,
transparent background, chunky rounded folk-geometric forms in the Hayba
logo's language (read `unreal/HaybaMCPToolkit/Resources/HaybaLogo.svg`),
two-tone: dominant cream body + ONE ochre accent element. Must read at 28px.

## Generate 3 CANDIDATES per icon
Name them `<name>-a.png`, `<name>-b.png`, `<name>-c.png` in
`docs/design/2026-08-23-extension-redesign/icons-v3b/`. Vary the metaphor or
its treatment across candidates, not just noise.

## The six, metaphor first

1. **activity** — a TIMELINE: three or four rounded event blocks stacked
   vertically along an implied spine, the topmost (newest) block ochre.
   Candidates may try: vertical stack with connector nubs; a column of
   rounded rows like a list; blocks descending in recency.
   Must NOT read as an hourglass, spine bone, or figure.

2. **recipe** — a REPEATABLE EDIT: a stamp seen slightly from the side with
   its imprint below it (object + the mark it leaves), imprint ochre.
   Candidates: stamp above + imprint below; a mold and its casting; a
   rounded press leaving a repeated mark. Must NOT read as a person or pawn.

3. **plan-pending** — AWAITING APPROVAL: a rounded document/sheet with an
   ochre wait-wedge (quarter-circle clock wedge) cut into or sitting on its
   corner. Candidates: sheet + corner wedge; sheet + small clock disc
   overlapping; a paused checklist (rows with the last row ochre and
   detached). Must NOT read as a chess piece or vessel.

4. **rules** — WHAT MUST BE TRUE: a standing stone tablet with two or three
   carved horizontal law-lines, one line ochre. Candidates: rounded stele
   with carved bands; tablet with lines + a small check notch; two stacked
   tablets. Strictly two tones — NO white elements. Must NOT read as a
   thimble, bell, or chair.

5. **profile** — WHAT AN ASSET IS (a measured object): a simple rounded
   object (crate/block) with an ochre measuring band or caliper bracket
   around its middle — the band is the "measured" statement. Candidates:
   block with wrap-around band + tick; object inside a bracket; object on a
   small plinth with a measure mark. Must NOT read as a vase or jar.

6. **diff** — BEFORE/AFTER: two side-by-side rounded panels, left cream and
   right ochre, with a small notch or arrow between them showing direction.
   Candidates: two panels + center notch; two panels with the right one
   slightly changed in silhouette (the change IS the diff); split shape with
   a clean vertical seam and a connector. Must read as "two versions", not
   an abstract split pebble.

## Deliverables
- 18 PNGs (6 × 3 candidates) in `icons-v3b/`, palette-normalized,
  transparent, 512px.
- `contact-sheet.png` — one compiled grid image of all 18 with labels, so
  they can be reviewed at a glance.
- `NOTES.md` — one line per icon: which candidate you consider most telling
  and why. Do not delete or modify anything in `icons-v3/`.
