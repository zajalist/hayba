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

## Verification status

- TypeScript: `npm run typecheck` clean, `npm run lint:legacy-wrappers` clean,
  1011/1012 tests pass. The single failure is `landscape-import.test.ts`, which
  fails on a clean tree too (pre-existing, unrelated).
- C++: **not compiled, not run.**
- Live editor: **nothing has been exercised against a running UE.**

## Still to do

1. **Rebuild the plugin** and run the loop end to end against a real blueprint:
   `ui_build_tree` → `ui_compile_widget` → `ui_validate` → `ui_save_widget`.
2. **Editor settings panel**: strictness is fully wired through MCP
   (`validator_strictness`) and persists to `.scratch/validator-config.json`,
   which is the same file `HaybaMCPValidationPanel` already reads for the rule
   disable list. The panel does **not** yet have a strictness control — that
   is a per-category dropdown over the existing config, and is the one piece of
   the "configurable in settings" ask that was not built.
3. **Calibrate the measurement path.** The character-count hints are only as
   good as `ui_layout_snapshot`'s `available_width`. Once the plugin builds,
   check a known label against the designer and confirm the numbers agree
   before leaning on them.
4. **Grow the ruleset.** 32 rules ship. Adding one means appending an entry to
   `src/validator/ui/rules.ts` — the runner, the settings surface and the
   strictness gate all read that array, so nothing else needs touching. Gaps
   worth filling: focus-navigation graph reachability, per-widget clipping
   behaviour, ListView entry-class checks, animation-track validation, and
   input-action binding coverage.
5. **Not built:** `ui_bind_event` (widget delegate → blueprint event graph) and
   widget-animation authoring. Both need Kismet graph / MovieScene work that
   was out of scope here.

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
