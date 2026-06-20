# Semantic Studio — Plan C Implementation Plan

> UE 5.7 C++/Slate + TS. Compile + visual gates. Serial execution (editor CLOSED to build). Builds on Plans A + B (committed on `feat/mcp-ux-validation-overhaul`).

**Goal:** Finish the Semantic Studio ecosystem — a library browser over all profiled assets, bulk operations, the green/red plan-mode viewport overlay, and the `plumb_study` AI-orchestration entry point.

**Architecture:** Reuse the shipped PLUMB stores (`.scratch/profiles.json`, `constraints.json`, env-aligned in B7) and the Studio's `OpenStudioForAsset`. The library is a new dockable view; the overlay is a level-viewport consumer of the Verdict; `plumb_study` is a thin MCP tool that hands the agent the profile + a prompt scaffold.

## Global Constraints
- Build: editor CLOSED, `Build.bat UnrealEditor Win64 Development -Project="D:\UnrealEngine\template\template.uproject"`; relaunch to verify; screenshot via EnumWindows+PrintWindow(2).
- Stores under `ProjectDir/.scratch` (env `HAYBA_PROFILES`/`HAYBA_CONSTRAINTS`).
- Closed primitive set unchanged; no `Co-Authored-By` trailer.
- TS additions: `plumb_`-prefixed, registered + `ALWAYS_ON_META` + `passthrough` + `reg` + routing fixture; `npx tsc` + vitest.

---

### Task C1: Semantic Library browser
Upgrade the half-built Memory panel (`HaybaMCPMemoryPanel`) into a real library: one row per profiled asset (from `profiles.json`) showing asset name, archetype, mask count, constraint count, locked-field count, and an **Open in Studio** button (`FHaybaMCPModule::OpenStudioForAsset`). A search box filters by asset path. Refresh re-reads the store. Verify: bake ≥1 profile, open the panel, see the asset row + counts, click Open → Studio targets it.

### Task C2: Bulk operations
On the library, multi-select rows (checkboxes) + a bulk action bar: **Re-bake**, **Apply constraint template** (pick a primitive + params, write a constraint bound to each selected asset), **Bulk lock/unlock**, **Remove profile**. Writes through the stores; logs what changed. Verify: select 2 assets, apply a `grounded` template, confirm both get the constraint in `constraints.json`.

### Task C3: Green/red plan-mode viewport overlay (the original Phase 4)
In the LEVEL viewport (not the Studio), when Plan Mode is active, draw per-instance Verdict status: green box = passes, red = a hard gate fails, with the fix-vector arrow. Reads the same Verdict from `plumb_validate` over the level's placed instances (matched to profiles by asset). A level-viewport overlay (FEditorViewportClient draw via a viewport extension / `UDebugDrawService`). Verify: place an instance violating a `grounded` constraint, toggle Plan Mode, see it outlined red with a fix arrow; satisfy it → green.

### Task C4: `plumb_study` MCP tool + "Study with AI" wiring
A `plumb_study` TS tool: given an asset, returns its profile (or bakes it) + a structured prompt scaffold listing the closed primitives/mask kinds, so the agent can propose masks (`plumb_mask_add`) + a constraint graph. The Studio's "Study with AI" button writes a `study-request` event to `.scratch` (plan-events style) that the agent watches. Verify: tool returns the scaffold; button emits the event file.

---

## Self-Review
- Spec §7 library → C1; §8 bulk → C2; Phase-4 overlay → C3; §6 plumb_study → C4. ✔
- Each task is independently shippable + visually verifiable. C1/C2 reuse the store + Studio entry; C3 is a separate viewport consumer; C4 is TS + a thin button.
- Order: C1 → C2 (depends on the library UI) → C3 (independent) → C4 (independent). C3/C4 can swap.
