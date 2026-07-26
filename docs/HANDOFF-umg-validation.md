# Handoff: UMG toolset overhaul + UI validation engine

**Date:** 2026-07-26
**Branch:** `feat/umg-validation-engine`

## What this changed

Two things: the UMG authoring tools got fixed and extended, and a UI validation
engine was added on top of real Slate measurement.

### Architecture decision worth keeping

**UE measures, MCP judges.** The plugin gained exactly two new read commands
(`ui_layout_snapshot`, `ui_measure_text`) that do the one job only the engine
can do — a real Slate prepass plus font metrics. Every rule that interprets
those numbers lives in TypeScript (`src/validator/ui/`), so:

- rules are unit-tested without an editor (54 tests, all green),
- new rules ship without a plugin rebuild,
- strictness and per-category config are plain JSON both sides read.

Do not move rules into C++.

## Bugs found and fixed (all were silent)

| What | Symptom |
|---|---|
| `ui_search_widgets` never sent `path` | every call failed `ui_query: missing path` |
| `ui_set_slot_layout` sent `slot_layout` | no handler revision read that key — every call failed "no properties provided" |
| `HaybaReflection::SetProp` rejected JSON objects for struct properties | `ui_set_brush` and `ui_set_text_style` could not set a brush or a font at all |
| `ui_set_text_style` sent `Typeface: {FontName}` | matched no property; the field is `TypefaceFontName` |
| `ui_set_brush` sent `Brush` to Borders | Borders expose theirs as `Background` |
| slot props counted as succeeded unconditionally | success counts included keys the slot never accepted |
| padding only applied when non-zero | padding could never be cleared |
| `preserve_properties` on replace | parsed, then never used |
| `remove` purged only the named widget's GUID | descendants left phantom entries in `WidgetVariableNameToGuidMap` |
| `replace` reused a name the old widget still held | UE silently uniquified to `Name_1`, breaking bindings |
| `reparent` discarded slot layout, no index | and orphaned the widget entirely if the new panel refused it |
| descriptor text claimed `FScopedTransaction` | deliberately removed in c071a59; several `returns:` strings named fields that did not exist |

## New commands (C++) — **needs a plugin rebuild**

`ui_build_tree`, `ui_set_variable`, `ui_list_widget_blueprints`,
`ui_layout_snapshot`, `ui_measure_text`, plus `ui_mutate_tree` operations
`move` / `rename` / `duplicate`, and `ui_query` filters
(`name_pattern` / `class_filter` / `flatten`).

New files: `handlers/HaybaMCPUILayout.{h,cpp}`.

**The C++ has not been compiled** — no engine build ran in this session. Build
the plugin before trusting any of it. Things to check first if it does not
compile:

- `UWidget::IsFocusable()` and `UWidget::SetCategoryName` availability on 5.8
- `UUserWidget::TakeWidget()` on an editor-world instance in
  `HaybaUILayout::ComputeGeometry` (it deliberately never uses a PIE world —
  see `[[haybamcp-pie-transaction-leak]]`)
- `FBlueprintTags::ParentClassPath` include path

## Verification status (2026-07-26, after a live run)

The plugin **compiles and links** against UE 5.8, and the core loop has been
exercised against a running editor.

Verified live, on `/Game/ReelAssets/UI/WBP_ValidatorProbe`:

- `ui_build_tree` — 13 widgets across two calls, canvas and box/grid slots, all
  three padding shapes (scalar, `[l,t,r,b]`, `{left,top,…}`), zero rejected keys
- `ui_layout_snapshot` — `layout_resolved: true`, geometry matching the authored
  values, fonts resolved, text measured
- **Text measurement is exact at the boundary**: 12 chars = 199px fits, 13 chars
  = 219px overflows, in a 200px box
- `ui_validate` — every seeded defect caught, `rules_skipped_no_layout` empty,
  platform gate holds (pc 24px vs console 40px targets; safe areas console-only)
- Contrast measured 6:1, silent at standard (4.5:1), fires at strict (7:1)
- Previously-broken paths now work and **persist** (confirmed by re-query):
  `ui_search_widgets`, `ui_set_slot_layout`, `ui_set_text_style`, `ui_set_brush`
  (both `Brush` and `Background`), `ui_replace_element` (34 properties copied,
  name kept), `ui_rename_element` (GUID preserved), `ui_move_element`,
  `ui_set_variable`, `ui_list_widget_blueprints`

TypeScript: typecheck clean, `lint:legacy-wrappers` clean, 44 UI tests + 27 rule
tests green. The one repo-wide failure is `landscape-import.test.ts`, which
fails on a clean tree too (pre-existing, unrelated).

### Needs the next plugin rebuild

Two C++ fixes are committed but **not yet compiled into the running editor**:

1. `ui_duplicate_element` corrupted the tree — `DuplicateObject` keeps every
   descendant's name and UMG requires tree-wide uniqueness, so UE renamed the
   collisions to `TRASH_<name>` and left two widgets answering to `Card`. Until
   the rebuild lands, **do not use this tool**.
2. `ui_report_findings` — the route that puts findings in the Validation panel.

### Still untested

`ui_remove_element`, `ui_reparent_element`, `ui_get_widget_info`,
`ui_list_widget_types`, standalone `ui_save_widget`, the
`validator_strictness` persistence round-trip, and the non-canvas slot rules
against a real box layout (the box tree exists in the probe, but only four
rules have been run against it).

The probe blueprint currently contains the corrupt duplicate; clean it after
the rebuild.

## Rule catalogue shape

```
src/validator/ui/
  types.ts        snapshot + rule types
  thresholds.ts   platform presets (pc/console/handheld/mobile) + strictness
                  tuning, every number cited to its source
  rules.ts        the 32 rules
  index.ts        runner: strictness gate, disable list, skip accounting
```

`resolveThresholds` scales pixel numbers to the blueprint's design height, so a
720p-authored screen is judged with 720p numbers.

**Reporting contract:** a rule that needs geometry and has none is reported in
`rules_skipped_no_layout`, never counted as a pass. Same principle as the
per-key `unknown_slot_props` reporting on the authoring side — the whole point
of this pass was that silence was being read as success.
