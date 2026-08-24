# Icon set v3 — AI-generated, logo-matched

## Verdict on v2 (why it was rejected)
The v2 set is thin 1.8px outline strokes. The Hayba logo is the opposite
language: **solid filled silhouettes** — chunky, rounded, folk-geometric,
two-tone (cream body `#DED4C3` + ochre `#B56A1D` bands), like a hand-cut
woodblock mark. Outline icons can never sit beside it. v3 must be built in
the logo's own language.

## Method (required)
Generate the icons with **AI image generation** (your image-generation
capability), NOT hand-authored SVG paths. Study
`unreal/HaybaMCPToolkit/Resources/HaybaLogo.svg` first — read the file, note
the shape language: the rounded hut silhouette, the banded roof (three ochre
bands), the little spark mark, the soft symmetry, zero outlines, zero
gradients (one drop shadow which you should NOT reproduce in icons).

## Style contract for every icon
- **Filled silhouette only.** No outlines, no strokes, no thin lines.
- **Two-tone**: a dominant body tone + one accent element per icon (a band,
  a notch, a mark) — mirroring how the logo uses its ochre roof bands.
  Colors MAY diverge from the logo's cream/ochre (the UI palette in
  `palette.md` is available); what is non-negotiable is that the set and the
  logo read as one design system: same shape language, same two-tone
  band/accent logic, same visual mass.
- Chunky, rounded, symmetrical-leaning forms. Folk-geometric / woodblock.
  Simple enough to read at 28px and survive at 16px.
- **Transparent background. No frame, no circle backplate, no shadow, no
  gradient, no texture, no 3D.** Flat shapes.
- Consistent visual mass across the whole set — every icon should look cut
  from the same sheet.
- Square canvas, generate large (512px or larger), we downscale.

## The 13 icons + 3 state marks

Sidebar nouns:
1.  `world`    — the understood scene: a rounded landform/hill silhouette
                 with an ochre survey band, in the logo's hill-like language.
2.  `library`  — stacked shelves/strata, one ochre layer.
3.  `rules`    — a tablet/stele with carved bands, one band ochre.
4.  `activity` — a vertical flow of rounded blocks (a timeline), one ochre.
5.  `chat`     — a rounded speech shape, ochre notch.
6.  `settings` — a chunky rounded gear, ochre center.

Semantic:
7.  `profile`       — a rounded object with a measuring band (ochre).
8.  `recipe`        — a stamp/mold shape (repeatability), ochre imprint.
9.  `rule-pass`     — a rounded shield with a bold cream check, ochre rim band.
10. `rule-violated` — a rounded warning form with a heavy exclamation, ochre.
11. `plan-pending`  — a rounded hourglass or sun-dial form, ochre band.
12. `diff`          — two rounded halves, one cream one ochre.
13. `undo`          — a chunky curled-back arrow, ochre tip.

State marks (small, simple, solid — for compositing at bottom-right):
14. `state-attention` — solid ochre rounded triangle.
15. `state-pending`   — solid ochre circle with a wedge cut (clock-like).
16. `state-unsaved`   — solid ochre dot.

Avoid: hay/barn/farm literalism, robots, sparkles, magic wands, floppy disks.

## Deliverables
Into `docs/design/2026-08-23-extension-redesign/icons-v3/`:
- One PNG per icon, transparent background, ≥512px, named `<name>.png`.
- `preview.html` — SELF-CONTAINED (embed the PNGs as base64 data URIs — no
  external file references; the viewer sandbox blocks them). Dark page using
  surface `#20252B`: show every icon at 28px and 16px, a mock sidebar strip
  next to the actual Hayba logo (embed it too) so style-match can be judged
  directly, and the three state marks composited over two noun icons.
- `NOTES.md` — one paragraph: generation approach, any icon that fought the
  style contract and what you did.

If your image generation is unavailable or produces unusable results, STOP
and write NOTES.md saying exactly that — do not fall back to hand-drawn SVG.
