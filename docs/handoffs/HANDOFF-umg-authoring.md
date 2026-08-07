# Handoff: Enable UMG (Widget Blueprint) authoring through the Hayba MCP

**Author of handoff:** Claude (Aphrosia session), 2026-07-19
**Audience:** the next Claude/dev working in `D:\Hackathons\hayba`
**One-line goal:** make `ui_create_widget` / `ui_add_element` / `ui_query` **agent-callable** so an agent can build & edit UMG Widget Blueprints in a live UE editor via the MCP — instead of hand-writing UMG in C++.

---

## ✅ DONE (2026-07-19) — native-TS route

The TS wrappers now exist. `list_tool_categories` will report the `ui` domain with
`callable_count: 3` after reconnect. What was added (all in `mcp-tools/hayba-mcp`):

- `src/tools/ui/ui-create-widget.ts`, `ui-add-element.ts`, `ui-query.ts` — Zod
  schemas + handlers calling `executeCommand('ui_*', args)` (mirrors `material_*`).
- `src/tools/index.ts` — 3 `ToolDescriptor` entries in `HANDWRITTEN_STANDARD_DESCRIPTORS`
  (`niche: UI`), the `UI` niche const, and an `inferDir('ui_') → 'ui'` pack entry.
- `src/tools/niche-briefing.ts` — a `ui` first-touch briefing.
- `src/tools/ui/ui-tools.test.ts` — 7 passing tests (registration + dispatch + param names).
- Built to `dist/`; typecheck + `lint:legacy-wrappers` green. **Legacy route NOT used**
  — the `ui` domain is a modern `IHaybaMCPHandler`, absent from the C++ legacy dispatch
  table, so the native-TS route was correct (confirmed: lint stays green with no sidecar edits).

### ⚠️ Param-name corrections (the `.cpp` is the source of truth; this doc was wrong)

The wrappers follow `HaybaMCPUIHandler.cpp`, which differs from the contracts below:

| command          | doc said                 | actual C++ reads              |
|------------------|--------------------------|-------------------------------|
| `ui_add_element` | `properties`             | **`slot_props`**              |
| `ui_query`       | `widget_blueprint_path`  | **`path`**                    |
| `ui_create_widget` | `parent_class` required | **optional** (defaults `UserWidget`) |

Returns also differ from the doc: `ui_add_element` → `{widget_blueprint_path, parent,
name, class, slot_class}`; `ui_query` → `{path, parent_class, root:{name,class,slot,children}}`.

### Known gap (not blocking, worth a follow-up)

The C++ handler `MarkBlueprintAsStructurallyModified` + `MarkPackageDirty` but does **not**
compile or save. The "Compile after edits" gotcha below overstates what the handler does —
after `ui_add_element` you likely still need an explicit save (`asset_save`) for the BP to
survive an editor restart, and a BP compile before use.

---

## Why this matters (motivating case)

In the Aphrosia project I built a start screen by constructing the UMG tree in **C++** (`UStartScreenWidget::BuildTree`, `WidgetTree->ConstructWidget<...>()`). It works, but two things bit us and both are symptoms of "no visual UMG authoring":

1. **Fonts render as `UFontFace` preview tiles** ("BASIC LATIN / A / 0000–007F" boxes) because `FSlateFontInfo(UFontFace*, size)` does **not** render a raw Font Face — Slate needs a composite **`UFont`** asset (or a Font Face assigned through the UMG designer, which wraps it correctly). In a Widget Blueprint you just pick the font and it works.
2. The whole start screen is binary-invisible: a `.uasset` Widget Blueprint would be designer-editable; C++ is not.

If the MCP could author Widget Blueprints, agents would use Unreal's real UMG pipeline (designer-compatible, font picker works, artists can tweak).

## Current state (verified this session)

- **UE plugin handler is COMPLETE.** File:
  `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPUIHandler.{h,cpp}`
  - `FHaybaMCPUIHandler : IHaybaMCPHandler`, `GetDomain() == "ui"`.
  - `GetCommands()` → `ui_create_widget`, `ui_add_element`, `ui_query`.
  - Real implementation: `UWidgetBlueprintFactory` to create the BP, `WidgetTree->ConstructWidget`, panel-slot handling (Canvas/Horizontal/Vertical), reflection-based property setting, `FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified` + compile, asset registry notify. A `ResolveWidgetClass` map already supports Button/TextBlock/Image/CanvasPanel/HorizontalBox/VerticalBox/Overlay/ScrollBox/Border/GridPanel/UniformGridPanel/SizeBox/Spacer/CheckBox/EditableTextBox/ProgressBar/Slider, plus full class-path lookup.
- **MCP/TS wrapper is MISSING.** `list_tool_categories` reports the `ui` domain with `callable_count: 0` and all three under `unavailable`. The legend: *"unavailable = plugin supports it but no agent wrapper exists yet (calling it errors)."*
- `src/legacy-commands/sidecar.json` has **no `ui_*` entries** (grep returns nothing).

## Command contracts (read from `HaybaMCPUIHandler.cpp` — source of truth)

- **`ui_create_widget`** → creates a Widget Blueprint asset.
  - `path` (string, required): content package dir, e.g. `/Game/Aphrosia/UI`.
  - `name` (string, required): asset name, e.g. `WBP_StartScreen`.
  - `parent_class` (string, required): must derive from `UserWidget`. Accepts a class path
    like `/Script/Aphrosia.StartScreenWidget` or `/Script/UMG.UserWidget`.
  - Returns: `{ path, parent_class }` (created asset path + resolved parent).
- **`ui_add_element`** → adds a widget to an existing BP's tree.
  - `widget_blueprint_path` (string, required).
  - `child_class` (string, required): short name (e.g. `Button`, `TextBlock`, `EditableTextBox`) or full class path.
  - `parent_widget_name` (string, optional): name of an existing **panel** widget to parent under; defaults to the root panel (errors if root isn't a panel and none given).
  - `name` (string, optional): name for the new widget.
  - `properties` (object, optional): slot props `x,y,w,h,fill,padding` are handled explicitly for canvas/box slots; any other key falls through to reflection (`FProperty::ImportText_Direct`) on the widget or its slot.
  - Returns: created widget `{ class, slot{...} }`.
- **`ui_query`** → returns the widget tree of a BP (per-widget `class` + `slot`).

## What to build (TS side) — recommended route

Make the three commands **natively callable** (matches how `material_*`, `actor_*` are exposed), so they work both directly and via `hayba_invoke(..., via:"ts")`.

1. **Add a `ui` tool module** under `src/tools/ui/` (mirror an existing domain, e.g. `src/tools/material/`):
   - Zod schemas for the three param contracts above.
   - Each tool calls the UE bridge the same way other tools do — grep an existing tool for the `executeCommand('<name>', args)` / `dispatch('<name>', ...)` helper and reuse it (the invariant doc in `sidecar.json` says wrappers live under `src/tools/**`).
   - Register the tools in the pack that the core/domain loader reads (see how `material` tools get into the `core` pack; `hayba_pack_load('core')` already lists `material_*`).
2. **Register in the catalog** so `list_tool_categories` moves them from `unavailable` → `callable`. See `src/catalog.ts` (+ `catalog.test.ts`) for how the callable/unavailable split is computed.
3. `npm run build` (emits `dist/`), then the user restarts Claude Code / reconnects the `hayba` MCP.

### Alternate/quick route (legacy allowlist)

If the ui handler is reachable through `HaybaMCPLegacyHandler`'s dispatch table, you can instead add three `sidecar.json` entries with `agent_callable: true` and `has_ts_wrapper: false`, which exposes them via `hayba_invoke(name, via:"ue_legacy")`. **But** `sidecar.json`'s own `_doc` + `scripts/check-legacy-wrappers.ts` enforce invariants: *every dispatch-table command in the `.cpp` must have a sidecar entry; `has_ts_wrapper` must match whether a `src/tools/**` call exists.* Confirm whether the `ui` domain is in the legacy dispatch table before taking this route — it's a **modern `IHaybaMCPHandler`**, so it may not be, in which case the native-TS route above is correct. Run `npm run lint:legacy-wrappers` after any sidecar edit.

## Verification

1. Rebuild MCP + reconnect. `list_tool_categories` → `ui` domain `callable_count: 3`.
2. With a live editor:
   ```
   ui_create_widget { path:"/Game/Aphrosia/UI", name:"WBP_Test", parent_class:"/Script/UMG.UserWidget" }
   ui_add_element  { widget_blueprint_path:"/Game/Aphrosia/UI/WBP_Test", child_class:"CanvasPanel", name:"Root" }
   ui_add_element  { widget_blueprint_path:"/Game/Aphrosia/UI/WBP_Test", child_class:"TextBlock", parent_widget_name:"Root", name:"Title", properties:{ x:40, y:40 } }
   ui_query        { widget_blueprint_path:"/Game/Aphrosia/UI/WBP_Test" }
   ```
   Expect the BP to appear in the Content Browser with a Canvas + TextBlock.

## Immediate payoff for Aphrosia (once callable)

Create `WBP_StartScreen` with `parent_class = /Script/Aphrosia.StartScreenWidget` (the existing C++ base keeps the auth logic + animations), then set fonts/brushes in the BP so the **font renders correctly** (fixes the UFontFace tile bug) and artists can tweak layout visually. Point `AMainMenuPlayerController` at the BP class instead of the raw C++ class.

## Gotchas
- **Fonts:** if you keep any code-set fonts, use a `UFont` composite asset, not a `UFontFace` — `FSlateFontInfo(UFontFace*, size)` shows the preview tile. The UMG designer path avoids this.
- **Compile after edits:** `ui_add_element` should mark the BP structurally modified and compile (the handler already does this) — verify the asset is saved (`asset_save` / `EditorLoadingAndSavingUtils`) so it survives editor restart.
- **Plugin lives via junction:** `D:\Projects\aphrosia\Plugins\HaybaMCPToolkit` and `.../geoforge/Plugins/HaybaMCPToolkit` are junctions to `D:\Hackathons\hayba\unreal\HaybaMCPToolkit` — editing the plugin here affects all of them.
- **Engine 5.8**, BuildId 55116800. `hayba_check_ue_status` must show `connected:true` before any `ui_*` call.
