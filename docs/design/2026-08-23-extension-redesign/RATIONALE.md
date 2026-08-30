# Visual system rationale

The icon set uses one 24×24 keyline with a 2px safe margin and a consistent 1.8px rounded stroke. This is a deliberate shift from the old arbitrary solid fills: open geometry keeps the set legible at 16px, while repeated structural motifs give the icons a constructed, survey-like character that sits beside the existing hay-store logo without illustrating hay, barns, or farms.

Every SVG uses `viewBox="0 0 24 24"`, has no filters or raster content, and separates its artwork into `<g id="base">` and `<g id="state">`. Base artwork inherits `currentColor`; noun state layers are empty and the UI composites one of three shared marks — attention, pending, or unsaved — when needed. State marks are small, intentionally not full-icon recolors, so ochre remains meaningful.

The semantic ochre is `#C47A28`, a slightly brighter legibility-tuned relative of the logo’s `#B56A1D`. The logo stays exactly as supplied. Ochre is used for active, pending, unsaved, or attention-needed states only. Pass and fail use restrained green and red so they remain status signals rather than competing brand palettes.

Two icons deviate slightly from a pure single-weight treatment: `chat` uses a 2.4px dot weight for tiny punctuation, and `rule-violated` uses a 2.2px exclamation stem. `plan-pending` uses a clock in its base geometry so the wait meaning is intrinsic rather than a corner decoration. Without the optical correction, the tiny chat dots and violation stem disappear at 16px. The underlying geometry and primary stroke remain 1.8px.
