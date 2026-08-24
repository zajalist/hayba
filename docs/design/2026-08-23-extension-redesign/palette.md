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
