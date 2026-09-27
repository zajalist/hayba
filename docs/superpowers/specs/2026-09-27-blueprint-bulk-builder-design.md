# Blueprint bulk builder — design

**Status:** design approved 2026-09-27 · awaiting spec review
**Branch:** `feat/hayba-brain-client` (stacked; includes `feat/blueprint-event-authoring`)
**Origin:** the bulk graph builder handoff from the first consumer project (2026-09-26) + 2026-09-27 addendum.

## 1. Intent

Make whole-Blueprint authoring from a JSON spec a first-class Hayba capability. Today a
standalone Node script (`bpgraph.mjs` in the first consumer project, patched
2026-09-27) drives the plugin over raw TCP with ~700 single commands per two specs (~158 s)
and can leave half-built graphs. Replace it with:

- `blueprint_spec_check` — offline spec validation (no editor).
- `blueprint_build_from_spec` — four-pass build (skeleton → graphs → CDO → verify) using a
  new bulk, all-or-nothing C++ `blueprint_apply_graph`.

**Success:** the 8 specs of the first consumer project rebuild as copies under `/Game/HaybaMCPAutomation/SpecBuild/`
with node/link counts matching each spec, clean compiles, zero missing links and zero ghost
events on every graph (including >50-edge graphs), and all Hayba gates green.

## 2. Source of truth to port

- `bpgraph.mjs` **current** version (includes four 2026-09-27 patches: pin names taken from
  the add-node reply; `--reset-graphs` removes in rounds; pass-4 treats connect-verified links as
  found when inspect is truncated; `add_variable` "already exists" is a warning). Pre-patch copy
  for diffing stays with that project.
- `bpgraph.test.mjs` (27 tests), `specs/README.md` (format), `specs/*.json` (8 specs).
- Spec sizes at design time: from specs that only set class defaults, over widgets of a
  handful of nodes, to an actor component of about 300 nodes and 370 links. The largest single
  graph has about 70 nodes. The specs belong to a private project and are not part of this
  repository; they are kept as a private corpus.

## 3. Spec format (unchanged, ported)

Top level `{asset, create?:{parent}, variables?:[{name,type,default?}], components?:[{name,class}],
functions?:[{name,inputs?,outputs?,pure?}], graphs?:[{graph, nodes:{name:{<kind>:v, x?,y?,
class?, inputs?}}, links?:[["a.Pin","b.Pin"]], defaults?:{"n.Pin":scalar}}], cdo_defaults?,
description?, $comment?}`. Node kinds: entry, result, event, custom_event, bound_event
`{target,event}`, call, get, set, branch, sequence, select, self, cast, create_widget, timer.

**New (additive):** `components[].properties?: {<property>: scalar}` — SCS component template
properties (closes addendum gap b).

## 4. Components

### 4.1 TypeScript — `mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/`

| File | Responsibility |
|---|---|
| `spec-parse.ts` | JSON-with-comments parser with duplicate-key diagnostics; type grammar mirroring `HaybaBlueprintOps::ParseTypeSpec` |
| `spec-check.ts` | All bpgraph validation rules (per spec + cross-spec) plus a warning for literals on by-reference inputs when pin metadata is known |
| `spec-plan.ts` | Pure planning: layout, pin resolution (exact → case/space-insensitive → cast `As*`), signature checks, `target_root` path rewrite; emits an ordered build plan (skeleton ops, per-graph `apply_graph` payloads, CDO/component ops) |
| `spec-build.ts` | Executes the plan through `executeCommand` (four passes) and produces the report |
| `spec-builder-tools.ts` | The two hand-written tool descriptors (`HANDWRITTEN_STANDARD_DESCRIPTORS`) with `when`/`not_when` guidance |

Tool inputs:

- `blueprint_spec_check {specs?: object[], spec_paths?: string[]}` → `{ok, errors[], warnings[], per_spec:[{asset, nodes, links}]}`.
- `blueprint_build_from_spec {specs? | spec_paths?, reset_graphs?: false, dry_run?: false, target_root?: string, allow_live_paths?: false}` → report (§5.3).

### 4.2 C++ — `HaybaMCPBlueprintHandler.cpp` (+ pure rules in `HaybaBlueprintOps`)

- **`blueprint_apply_graph`** `{path, graph_name, nodes:[{key, kind, …placement fields, x, y}], defaults:[{node, pin, value}], links:[{from_node, from_pin, to_node, to_pin}]}` → `{ok, node_ids:{key: guid}, pins:{key:[…]}, links_verified, defaults_verified, errors[]}`.
  - **Validate before mutate:** resolve every node kind/class/function, every pin name, and `CanCreateConnection` for every link against the planned nodes; reject the whole payload on any problem, naming the offending node/pin/link.
  - **Apply:** create nodes → set defaults → connect links.
  - **All-or-nothing:** if any step fails mid-apply, remove every node this call created (their links go with them) so the graph returns to its pre-call state. Do not rely on `CancelTransaction` to revert.
  - Registered as mutating (broken-BP gate), destructive (one editor transaction ⇒ one undo step), NON_IDEMPOTENT, heavy timeout tier.
- **`blueprint_inspect_graph`**: `offset`/`limit` paging over nodes and edges (`next_offset` when more remain); per-command response-builder override so the 50-item cap no longer truncates; per node `enabled`; per pin `default` (DefaultValue / DefaultTextValue / DefaultObject path).
- **`blueprint_set_component_property`** `{path, component_name, property, value}` → `{ok, applied, verified}` on the SCS component template; read-back verification.
- **`blueprint_set_pin_default`**: text pins compare `DefaultTextValue` (fixes false `verified:false`).

### 4.3 Wiring

C++ `GetCommands`/dispatch/mutating gate + `DestructiveCommands`; `sidecar.json` descriptors for
the new/changed commands; `NON_IDEMPOTENT` / `EXTRA_DESTRUCTIVE`; `list-tool-categories.ts`
(also add the missing add_event/add_custom_event/add_bound_event/remove_node and drop the stale
"stubs" comment); search-quality benchmark cases.

## 5. Data flow

### 5.1 Build
1. `blueprint_spec_check`; any error aborts.
2. **Skeleton** (per asset): create if missing; add missing variables (existing ⇒ warning);
   **update existing variables' defaults when the spec differs** (via `blueprint_set_defaults`;
   closes addendum gap a); add components; add functions or verify existing signatures
   (mismatch ⇒ abort with a clear message — Hayba cannot edit signatures); compile+save.
3. **Graphs** (per graph): if the graph has nodes/edges and `reset_graphs` is false ⇒ refuse;
   with `reset_graphs`, remove existing non-entry/result nodes in rounds using paged inspect.
   Place event/custom/bound events first and compile (custom events become callable), then one
   `blueprint_apply_graph` with all remaining nodes, defaults and links.
4. **CDO/components**: `blueprint_set_component_property` for component properties, then
   `blueprint_set_defaults` for `cdo_defaults`; compile+save.
5. **Verify**: paged inspect of every graph; every spec link must be a real edge and every
   linked event node `enabled`. Edges are counted only from complete paged reads (no trust of
   truncated replies).

### 5.2 Dry run
Check + plan only; returns the planned operations and counts; no editor calls.

### 5.3 Report
`{ok, duration_ms, assets:[{asset, compiled, graphs:[{graph, nodes_created, nodes_expected,
links_verified, links_expected, missing_links[], ghost_events[]}]}], warnings[], errors[]}`.
`ok` only if every count matches and nothing is missing.

### 5.4 Saving and path safety
Save only packages the build created or modified. Asset paths under a protected root the caller names
are refused unless `allow_live_paths: true`.

## 6. Error handling

| Case | Behaviour |
|---|---|
| Editor unreachable / PIE active | Refuse before any mutation (build never starts PIE) |
| `apply_graph` mid-apply failure | That graph rolled back; build stops; error names node/pin/link; earlier graphs intact |
| Compile errors | Reported; build stops; nothing further saved |
| TCP drop mid-build | No blind retry of `apply_graph` (NON_IDEMPOTENT); recovery = re-run with `reset_graphs` |
| Signature mismatch on existing function | Abort with explicit message |

## 7. Testing

- **TS (vitest):** port the 27 `bpgraph` tests; regression tests for the four patches and both
  addendum gaps; synthetic specs of the same shapes as the real ones (an invented sample game,
  `__fixtures__/synthetic/`) pass `check` with golden plan counts, and an optional corpus test
  runs the real specs from a private directory (`HAYBA_BLUEPRINT_SPEC_CORPUS`); scripted-UE end-to-end
  of the four passes including mid-apply rollback, >50-edge paged verify, live-path deny and
  dry run; extend the sidecar/gate contract tests to the new commands; search-quality cases.
- **UE automation (filter `Hayba`):** pure rules in `HaybaBlueprintOps` (payload validation, pin
  resolution, paging math, text-pin compare); one automation test applying a graph to a transient
  Blueprint and asserting rollback. Confirm the test count after build (UE can report success
  while omitting new files).
- **Acceptance (the first consumer project's editor):**
  1. Notify the consumer project's session; deploy C++ into `<project>/Plugins/HaybaMCPToolkit` and the TS `dist`; **full rebuild** (new commands/headers ⇒ not Live Coding) in an agreed window.
  2. `python <project>/Tools/GameFlow/editor_gate.py acquire --owner hayba-specbuild --timeout-min 60 --ttl-min 20`.
  3. `blueprint_build_from_spec` on all 8 specs with `target_root=/Game/HaybaMCPAutomation/SpecBuild`.
  4. Pass: counts match, clean compile, 0 missing links, 0 ghost events (incl. the largest graph); record timing vs. 158 s.
  5. Save only SpecBuild packages; `editor_gate.py release --owner hayba-specbuild`.
  6. Second run with `reset_graphs` proves idempotent rebuild.

## 8. Constraints

No AI/Co-Authored-By trailers; no push without asking; never start PIE; save only created
packages; never rebuild a protected root; editor access only under the editor gate
(holds < 20 min); coordinate with the first consumer project's session before deploying into its plugin copy.

## 9. Out of scope

Editing function signatures; rebuilding live GameFlow assets; chat-panel UI; Jev integration.
