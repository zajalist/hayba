# Architecture Atlas — Node-Based SVG Editor (Phase 2 of the editor track)

**Date**: 2026-05-13
**Status**: Draft — awaiting spec-review gate
**Pillar**: Architecture (`@hayba/architecture`)
**Branch**: `feat/architecture-pillar`
**Builds on**: Phase 1 binding persistence (`docs/superpowers/plans/2026-05-13-architecture-binding-persistence.md`)
**Successor**: Phase 3 (PBR library integration) and Phase 4 (in-atlas Claude chat panel) reuse the editor's "active binding" state.

## Goal

An in-browser, node-based vector editor that lets a user hand-edit any profile slot of any committed `ElementBinding` — drag vertices, add/remove them, snap-to-grid, hint-aware (symmetric-half / closed-path / open-path / tileable), with a live 3D preview that updates as you edit. Save round-trips through the Phase 1 POST endpoint so edits persist.

## Context

After Phase 1, AI-generated bindings persist to disk; we have the regen loop end-to-end. But the atlas is still **fundamentally read-only** for humans — you can only author by prompt. The SVG editor closes that gap: it's the *primary* authoring surface for everything that follows (texture editing, ornament editing, future element types). Without it, every iteration cycle goes through the AI, which is slow and non-deterministic.

The kernel already accepts SVG profile strings via `parseSvgProfile()`. The editor's only job is to produce *better* SVG strings from human intent. No new kernel surface needed.

## § 1 — Schema + integration

The editor is a pure-UI feature: **it never invents new binding shapes**. It edits the `profiles` field of an existing `ElementBinding` (the same object the AI pipeline produces and `registerBinding` consumes).

```
User opens editor for (styleSheetId, elementId)
        ↓
1. Loads binding from `bindings[`${styleSheetId}::${elementId}`]`.
2. For each profile slot in the element definition:
     Parse current SVG → array of {x, y} vertices (via parseSvgProfile, then read .points)
3. User edits vertices in Paper.js canvas.
4. On save:
     For each modified slot:
       Serialize vertices → SVG <path d="M x y L x y ... Z">
       Apply hint enforcement (close path / clamp x>=0 / etc.)
     Update binding.profiles[slotName] for each.
     POST to /api/bindings/:style/:element (existing Phase 1 endpoint).
     kernelMod.registerBinding(updatedBinding)  — instant in-session refresh.
     Re-render the bound-elements panel.
```

No new types, no new kernel functions, no new MCP tools. v0 work is contained in:
- `packages/architecture/demo/editor.js` — new editor module (Paper.js wiring, ~400 LOC).
- `packages/architecture/src/editor/` — new directory for pure-function utilities (svg-serialize, coord-map), with vitest unit tests.
- `packages/architecture/demo/index.html` — third "Editor" tab + minimal launch wiring (~150 LOC of additions).

**v0 only edits existing bindings.** To create a fresh `(styleSheet × element)` binding, user clicks ⟲ regen with the mock provider (gives a deterministic baseline), then opens the editor to refine. New-from-scratch is deferred to v1.

## § 2 — Paper.js integration + vertex model

**Paper.js setup**: loaded from CDN via the existing importmap (`paper@0.12+`). One global `paper.PaperScope` per canvas; the editor module owns it. Activated/deactivated on tab switch to avoid event listener leaks.

**Vertex model**: each profile slot maps to a Paper.js `Path` whose `segments[]` are the editable vertices. We use **straight line segments only** (no bézier handles) since `parseSvgProfile` doesn't support curves in v0 anyway — keeps the editor honest about what the engine can render.

```ts
// Per-slot editor state (one of these is "active" at any time):
interface SlotEditState {
  slotName: string;
  hint: 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';
  viewBox: readonly [x: number, y: number, w: number, h: number];   // from element.profileSlots[i].bbox
  path: paper.Path;                                                 // Paper.js path with editable segments
  dirty: boolean;                                                   // changed since last save?
  originalSvg: string;                                              // for revert / diff
}
```

**Tools** (4 in v0, Paper.js `Tool` objects):
- **Select** (default) — click vertex to select; shift-click to multi-select; drag to move; `Delete`/`Backspace` removes selected. Marquee-drag empty area for box-select.
- **Pen** — click anywhere to insert a vertex at the click point. For `closed-path`, click between two existing vertices to *insert* between them (Paper.js's nearest-segment hit-test); for `open-path`, append at the end.
- **Pan** — drag canvas. Also: hold space + drag.
- **Zoom** — scroll-wheel zooms toward cursor; double-click to fit-bounds.

**Hint enforcement** (live, not just on save):
- `symmetric-half` — vertices clamp to `x ≥ 0` at the moment they're created or dragged. Axis line at x=0 drawn dashed; left side (x<0) shaded muted.
- `closed-path` — Paper.js `path.closed = true`; visually shows a closing edge from last vertex back to first. Save serializes with `Z`.
- `open-path` — `path.closed = false`; no closing edge drawn.
- `tileable` — vertices on the left edge (x = viewBox.x) automatically mirror to the right edge (x = viewBox.x + w), same for top/bottom. v0: visualize the wrap by drawing ghost copies at +w / +h. Strict enforcement waits for v1.

**Coordinate mapping**:
- Paper.js canvas is in CSS pixels.
- We map (canvas px, canvas py) ⇄ SVG-space (viewBox coords) via Paper.js's `view.viewToProject`.
- View matrix is set on init to scale the viewBox into the canvas with the right Y-flip (engine uses Y-up; Paper.js + SVG use Y-down).
- All numeric display + save-serialized output is in **SVG-space (mm)**.

**Grid snap**: defaults to 5mm (configurable from a button in the top toolbar). On every vertex drag, snap to nearest grid point in viewBox-space. Grid drawn as faint lines at the same spacing.

## § 3 — Editor tab UI structure

```
┌────────────────────────────────────────────────────────────────────────┐
│ Toolbar (existing) — adds "Editor" tab next to Style guides / Typologies│
├────────────────────────────────────────────────────────────────────────┤
│ Editor top bar                                                          │
│  Editing /  Gothic column      [shaft] base capital_bot capital_top    │
│                                                                  [SAVE]│
├────────────────────────────────────────┬───────────────────────────────┤
│ Canvas area (Paper.js)                  │ Live preview                  │
│  [select][pen][pan][snap]                │ (three.js sphere/mesh)        │
│                                          │ rotates live                  │
│   ●━━━━━━━━━━━●                          │                               │
│   ┃           ┃                          │ ─────────────                 │
│   ●━━━━━━━━━━━●                          │ Hint: symmetric-half          │
│  grid 5mm · 4 vertices · closed          │ Vertices: 4                   │
│                                          │ Closed: yes                   │
│                                          │ Last saved: 2m ago            │
└────────────────────────────────────────┴───────────────────────────────┘
```

**Top-bar elements:**
- Breadcrumb: `Editing / <binding name>` (clickable → returns to Style guides tab with that binding focused).
- Slot tabs: horizontal list of all `element.profileSlots`; active slot highlighted, dirty slots show `●` indicator.
- **Save** button (right side). Disabled if no dirty slots. Orange when dirty, grey when clean. `Cmd/Ctrl + S` shortcut.

**Canvas area:**
- Floating tool palette top-left (4 tools, square buttons, ~28px).
- Floating coordinate readout bottom-left: `(mm coords) · grid 5mm · 4 vertices · closed`.
- ViewBox drawn as a dashed inset rectangle.
- Hint-specific overlays drawn (axis line for symmetric-half, ghost wraps for tileable, etc.).

**Right panel:**
- Live 3D preview (a smaller version of the existing 3D viewer modal — same orbit controls). Updates whenever ANY slot changes. ~280px tall.
- Stats: triangles, GLB size — pulls from `emitElementMesh`.
- Hint + vertex count + closed status for the active slot.
- "Last saved" relative timestamp.

**Bound-element card gains a new button**: alongside `⟲ regen`, add `✎ edit` that navigates to the Editor tab with that binding loaded.

## § 4 — Launch flow + state transitions

Three entry points into the editor:

**1. From a bound-element card** (the primary route)
- Click `✎ edit` on any bound-element card on the Gothic detail page → switches to **Editor** tab, loads that binding, opens its **first slot** active.
- 95% of users take this path.

**2. Manual via the Editor tab**
- Click the **Editor** tab directly. If no binding is currently loaded, empty-state: *"Pick a bound element from the Style guides tab, or click any ✎ edit button."*
- If a binding is already loaded (from a previous session), resume where you left off.

**3. After AI regen** — *v1*, not v0. After `✓ accepted`, show a small "Edit ↗" link to jump into the editor with the just-generated binding.

**Editor state machine** (a single `editor` object on the global state):

```ts
state.editor = null   // tab never opened, or fully discarded
state.editor = {
  bindingKey: 'medieval-european-gothic::column',
  activeSlot: 'shaft',
  slots: {
    shaft:           { hint, viewBox, path, dirty: false, originalSvg },
    base:            { ... dirty: false ... },
    capital_bottom:  { ... dirty: true  ... },     // ← user edited this one
    capital_top:     { ... dirty: false ... },
  },
}
```

**Dirty tracking** is per-slot. `originalSvg` is the SVG string the slot held when the editor opened (or last saved); `dirty` flips to `true` on any vertex change and back on Save.

**Save flow:**
1. Click Save (or `Cmd+S`).
2. For each `slots[name].dirty === true`:
   - Serialize Paper.js path → `<svg viewBox="..."><path d="M x y L x y ..."/></svg>`.
   - Apply hint enforcement (close `Z`, clamp `x>=0`, etc.).
   - Write into a new binding object: `{ ...current, profiles: { ...current.profiles, [slotName]: newSvg } }`.
3. Single round-trip:
   - `kernelMod.registerBinding(updatedBinding)` (in-memory, instant).
   - `await persistBindingToServer(updatedBinding)` (POST to `/api/bindings/...`, Phase 1 endpoint).
4. On 200: update each `slots[name].originalSvg = newSvg`, `dirty = false`. Show `Last saved: just now`.
5. On error: toast `Save failed: …`. Keep dirty state; user can retry.

**Discard flow:**
- Switching tabs with dirty slots → blocking confirm: *"You have unsaved changes in X slots. Discard?"* with `Discard / Save / Cancel`.
- Per-slot revert: right-click a slot tab → "Revert to saved" — resets just that slot's `path` from `originalSvg`.

**Closing the binding entirely:**
- Click breadcrumb → returns to Style guides tab. Same dirty-confirm gate.
- Loading a different binding — same confirm if anything's dirty.

**Browser-close protection**: `window.onbeforeunload` returns truthy when any slot is dirty → browser's native "Leave site?" prompt.

## § 5 — Live 3D preview + performance

The right-panel preview shows the **current state of the binding being edited, including unsaved changes**.

**Update cadence:**
- On any vertex drag/add/delete that produces a valid path: schedule a re-render via `requestAnimationFrame` (debounced — only one queued at a time).
- The actual re-render path: serialize all slot SVGs from current Paper.js paths → `kernelMod.registerBinding({...current, profiles: editedSnapshot})` (ephemeral, not persisted) → `kernelMod.emitElementMesh()` → load GLB into three.js scene.
- ⚠️ The ephemeral binding is NOT persisted. Disk write only on explicit Save.

**Performance:** Gothic column = 912 tris / 24 KB GLB. Kernel emit ~5–15 ms on a dev laptop. RAF debounce caps at 60 fps. No lag.

**Invalid-path handling:**
- If the user's current state would fail validation (e.g., dragged a `symmetric-half` vertex to negative x somehow, or path has <3 points for a closed shape), preview shows the **last valid mesh** with a warning overlay: *"Preview frozen — current shape would fail validation"*.
- The hint-enforcement layer (§ 2) catches most invalid states at the input layer; this is last-line defense.

**Camera state**: preserved across slot switches within the same session. Switching to a different binding resets to default framing.

**Mesh source-of-truth:** Engine `Mesh` → GLB → three.js. We never render Paper.js paths directly as 3D — always round-trip through the kernel. Guarantees what you see is what the engine will produce. No "previews fine, exports broken" surprises.

## § 6 — Testing strategy

The editor is browser-only and Paper.js-bound, so vitest unit tests only cover part of it. Split:

**Unit-testable in vitest (`packages/architecture/src/editor/*.test.ts`):**
- **SVG ⇄ vertex round-trip** — given an SVG string, parse into vertex list, re-serialize, assert equality with canonicalized coords.
- **Hint enforcement** — `clampSymmetricHalf(vertices)` zeros negative x. `closePath(vertices)` ensures last == first. Pure functions.
- **Path serialization** — `verticesToSvgPath(verts, viewBox, hint) → string`. Round-trip with `parseSvgProfile`.
- **Coordinate mapping** — `canvasToSvgSpace({px, py}, view) → {sx, sy}` and inverse. Tested with viewBoxes both origin-at-(0,0) and centered-on-origin (catches the bug we hit in the kernel earlier).
- **Snap-to-grid** — `snap(p, grid) → q`. Trivial.
- **Dirty detection** — given two SVG strings, classify changed slots.

Pure functions live in `packages/architecture/src/editor/`:
```
src/editor/
├── svg-serialize.ts        (verticesToSvgPath, sanitize, applyHint)
├── svg-serialize.test.ts
├── coord-map.ts            (canvasToSvgSpace, svgToCanvasSpace, snap)
└── coord-map.test.ts
```

The browser-side wiring (`demo/editor.js`) imports these via the built `dist/`.

**NOT unit-tested (visual / DOM):**
- Paper.js tool interactions (click/drag/select). Need Playwright + real Paper.js.
- Live 3D preview updates.
- Tab switching, dirty-confirm modals.

**Manual smoke checklist** (mandatory visual checkpoint per the determinism contract):

1. Open ✎ edit on Gothic column → editor opens on `shaft` slot with 8 verts visible.
2. Drag a vertex → 3D preview updates within a frame.
3. Switch to `base` slot → shaft's edits remain dirty (badge visible).
4. Save → both slots commit, disk file updates, dirty badges clear.
5. Hard-refresh → edits persist (Phase 1 wiring works).
6. Discard via tab switch with dirty → confirm prompt blocks, Discard reverts.
7. Try to drag a `symmetric-half` vertex past x=0 → vertex clamps; visual feedback.
8. Add 3 vertices in `Pen` mode to an open-path slot → path grows correctly.
9. Delete vertex → path closes around remaining.
10. Screenshot the editor in action; attach to implementation PR.

**Coverage target**: ≥80% on the pure-function files in `src/editor/`. Paper.js wiring is exempt (manual smoke covers it).

## Risks

- **Coordinate mapping bugs.** Centered viewBoxes have bitten us before (kernel SVG flip). The `coord-map.ts` tests must include both centered (`-100 -100 200 200`) and origin-corner (`0 0 200 1000`) viewBoxes, with assertions on round-trip equality and Y-flip direction.
- **Live preview lag for large elements.** Column is fine; if we add elements with thousands of triangles, we'd need a "preview quality" slider (lowers `revolve_segments` during edits, restores on save).
- **Paper.js bundle weight.** ~140 KB minified. Acceptable for an editor surface; not a blocker.
- **Dirty-confirm UX**. Native `confirm()` is ugly but reliable; a custom modal would be nicer but doesn't add functional safety. v0 uses native `confirm()`; v1 could swap.
- **Vertex-count limits.** Paper.js handles hundreds of segments per path cleanly; we cap at 500 vertices per slot in the validator with a friendly error.
- **Curves not supported.** AI can emit curve commands (C/Q) and `parseSvgProfile` throws. The editor only emits straight segments, so loading any binding with curves would fail parse → empty path. v0 mitigation: surface a clear "this binding has unsupported curve commands; regen to a straight-line version" message and disable editing. v1: tessellate curves into segments on load.

## Definition of done

- [ ] `Editor` tab visible in toolbar; clicking opens the Editor view.
- [ ] `✎ edit` button on every bound-element card, opening the editor for that binding.
- [ ] Slot tabs (one per `element.profileSlots`) at the top of the editor; click to switch active slot; dirty indicator (●) visible.
- [ ] Canvas renders the active slot's path via Paper.js, with editable vertex handles.
- [ ] 4 tools (Select / Pen / Pan / Zoom) wired and switchable.
- [ ] Grid snap (default 5mm), togglable, snap applies on every vertex drag.
- [ ] Hint enforcement: symmetric-half clamping with axis visualization; closed/open distinction; tileable ghost wrap.
- [ ] Live 3D preview in the right panel updates within a frame of vertex changes.
- [ ] Save button writes through Phase 1's POST endpoint; success clears dirty state; failure surfaces a retryable error.
- [ ] Discard / dirty-confirm on tab switch or close.
- [ ] `Cmd+S` keyboard shortcut for save.
- [ ] All 10 manual-smoke steps pass; screenshots committed.
- [ ] vitest pure-function tests ≥80% on `src/editor/`.
- [ ] Typecheck + build clean.

## Out of scope (v0)

- **New-from-scratch binding creation** in the editor. (Use ⟲ regen with mock provider to seed.)
- **Curve commands (C/Q/A) on load or save.** Editor refuses to load and prompts user.
- **Multi-binding tabs** (working on more than one binding at a time).
- **Edit history / time-machine** beyond per-slot revert.
- **Real-time collaboration** (Yjs etc.).
- **Custom hint types** beyond the four already in the schema.
- **Texture editing** (separate phase).
- **AI-assisted vertex placement** ("Claude, suggest where to add a vertex"). Future Phase 4.
- **Curve tessellation** — translating AI-emitted bézier curves into straight segments on load. v1.

## Open questions for follow-up

- **Should saving a slot kick off a full validator re-run** before commit (catching subtle issues like overlapping vertices)? Current plan: rely on hint enforcement + `parseSvgProfile` parse-test at load time. v1 could add deeper validation.
- **Per-binding undo history** vs the implicit "Revert to saved" — is one-step revert enough for v0? Likely yes; we add multi-step undo if users ask.
- **Mobile / touch interactions** — v0 is desktop-only. Paper.js supports touch events; if needed, we add tap-to-add / drag-with-finger later.
- **Authoring new element TYPES** (vs. just bindings) — defining a new `Element` JSON with new profile slots is out of scope. Element types remain hand-authored TS code.
