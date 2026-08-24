# Hayba extension visual tokens

The palette is a cool, neutral Slate ground that can live inside Unreal Editor chrome. Hayba’s existing cream-and-ochre logo remains the only brand mark; ochre below is a semantic signal, never decoration.

| Token | Hex | Use this when… |
|---|---|---|
| `surface.panel` | `#20252B` | rendering the primary docked panel background |
| `surface.raised` | `#292F36` | lifting cards, menus, and the active sidebar row |
| `surface.sunken` | `#171B20` | creating input wells, code-like regions, or recessed groups |
| `border.subtle` | `#3A424B` | separating adjacent controls without visual noise |
| `border.strong` | `#515B66` | showing focus, selected outlines, or a clear boundary |
| `text.primary` | `#E5E9ED` | labels and values that must be read first |
| `text.secondary` | `#AAB3BD` | supporting labels, metadata, and descriptions |
| `text.muted` | `#77828E` | quiet timestamps, disabled copy, and tertiary context |
| `accent.ochre` | `#C47A28` | active, pending, unsaved, or attention-needed state |
| `accent.ochre.hover` | `#D88A30` | hovering an already-semantic ochre control |
| `accent.ochre.pressed` | `#A96520` | pressing or committing an ochre action |
| `status.pass` | `#7EA58A` | a satisfied rule or completed check, quietly |
| `status.attention` | `#C47A28` | a pending approval, unsaved edit, or warning |
| `status.fail` | `#C46E68` | a violated rule or blocked operation, without neon red |

`#C47A28` is a legibility-tuned version of the logo’s `#B56A1D`: it keeps the same grounded ochre family while lifting small 16px strokes against Slate surfaces. The logo itself is not changed.

## Usage rules

- Base icon strokes use `currentColor`, normally `text.secondary` or `text.primary`.
- Each icon has a separate `<g id="state">`; tint that group with `accent.ochre` only when the UI state requires it.
- The sidebar active row uses `surface.raised` plus a restrained ochre state mark; do not paint the whole icon ochre.
- Pass and fail appear only beside their corresponding verdicts. They are not general-purpose brand colors.

## Categorical palette

Added 2026-08-24, after finding the Tool Stream carried ten category colours
inline and two of them broke the ochre rule.

Measured against the semantic ochre (hue 32°):

| Category | Old hue | Distance to ochre | Verdict |
|---|---|---|---|
| Performance | 30° | **1.5°** | indistinguishable from "needs attention" |
| Scene | 41° | **9.6°** | indistinguishable from "needs attention" |
| Actor | 196° | 165° | fine, but 7.6° from Plan |
| Plan | 204° | 173° | fine, but 7.6° from Actor |

Two categories reading as the accent colour is not a small problem: the whole
value of reserving ochre is that seeing it means something. And two categories
7.6° apart are not two categories.

The replacement hues sit **≥25° clear of the ochre and ≥30° apart** from each
other, at one shared saturation (0.48) and value (0.86) so no category shouts
louder than the rest. Value comes down from the originals' 1.0, which glares
against `#20252B`.

| Token | Hex | Hue |
|---|---|---|
| `Hayba.Color.Cat.Performance` | `#CADB72` | 70° |
| `Hayba.Color.Cat.Script` | `#95DB72` | 100° |
| `Hayba.Color.Cat.Scene` | `#72DB9E` | 145° |
| `Hayba.Color.Cat.Actor` | `#72CADB` | 190° |
| `Hayba.Color.Cat.Plan` | `#728CDB` | 225° |
| `Hayba.Color.Cat.Memory` | `#9972DB` | 262° |
| `Hayba.Color.Cat.Asset` | `#CD72DB` | 292° |
| `Hayba.Color.Cat.Image` | `#DB72AF` | 325° |
| `Hayba.Color.Cat.Neutral` | `#B0B6C0` | — |

**Error is deliberately not a category.** An error is a status; it uses
`Hayba.Color.Status.Fail`, so the two can never drift apart.

### Use this when…

Telling *kinds* apart — tool domains, asset types, graph node families. Never
for status, severity, or anything the ochre rule covers. If a colour is meant
to make someone act, it is a status token, not a category one.

The call sites are still the inline literals in `HaybaMCPToolStreamPanel.cpp`;
they move to these tokens with P3b, when that panel becomes Activity. Doing it
sooner would be churn in a file that is about to be substantially rewritten.
