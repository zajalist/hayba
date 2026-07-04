# Phase 2 Wave 1 — Legacy-Command Surfacing + Actor P0s

First breadth wave of the supertooling roadmap (Phase 2: "surface the tier-2
debt + quick py wins"). Builds directly on the Phase 0/1 foundation (single
descriptor list, pyTemplate factory, canonical error envelope).

## Global Constraints (binding)
- No false advertising: a surfaced tool must actually work when called (it
  dispatches to an existing, tested C++ handler via `executeCommand`).
- Single-source: surfaced tools flow through `STANDARD_DESCRIPTORS` (or an
  equivalently-consumed generated list) so registration + `get_tool_signature`
  + Code-Mode all see them with zero drift. No schema declared twice.
- The legacy-wrapper lint (`scripts/check-legacy-wrappers.mjs` +
  `npm run lint:legacy-wrappers`) MUST stay green — read it first and keep its
  invariants true (it ties sidecar `has_ts_wrapper` to literal
  `executeCommand('<name>')` occurrences under src/tools/**).
- TS gate: `npx tsc --noEmit` clean AND `npx vitest run` green in
  mcp-tools/hayba-mcp. New machinery gets unit tests.
- Non-idempotent surfaced commands (create/spawn/delete/add/remove/duplicate)
  must be added to `NON_IDEMPOTENT` in tool-executor.ts.
- Commit messages: no Co-Authored-By trailer.

## Task 1 — sidecar→descriptor generator (`legacy-tool-factory`)  [TS]

**Files:** new `src/tools/legacy-tool-factory.ts` (+ test); `src/tools/index.ts`
(consume the generated list); possibly `src/legacy-commands/sidecar.json` +
`scripts/check-legacy-wrappers.mjs` (invariant handling).

**Change:** a generator that reads `src/legacy-commands/sidecar.json` at module
load and, for every command with `agent_callable:true && has_ts_wrapper:false`
(≈55 today), produces a canonical `ToolDescriptor`:
- zod shape from `params[]` (`string`→z.string(), `number`→z.number(),
  `boolean`→z.boolean(), `array`/`object`→z.unknown() or z.array(z.unknown());
  `required:false`→`.optional()`; carry each param's `description`).
- description from the sidecar entry's doc field(s); returns doc likewise.
- cost: use the sidecar's cost/timeout hint if present, else `medium`.
- handler: `executeCommand(name, params)` returning via the canonical
  ok/error helpers (`tool-result.ts`).
- meta: a generated `HaybaToolMeta` (`when` from the description).
The generated descriptors are appended into the same list the eager loop and
`recordEagerSchemas` consume (mirror how Task 7/8 did it — likely a
`...generateLegacyDescriptors()` spread into `STANDARD_DESCRIPTORS` or a second
list iterated identically in BOTH loops).

**Lint invariant:** decide with evidence: either (a) mark surfaced entries
`has_ts_wrapper:true` in sidecar AND teach the lint that generator-surfaced
commands count as wrapped (e.g. it reads the generator's inclusion rule), or
(b) keep `has_ts_wrapper:false` and ensure the lint tolerates the generator's
dynamic dispatch. Whichever keeps `npm run lint:legacy-wrappers` green AND
truthful. Document the choice in the file header.

**Idempotency:** classify each surfaced command; add the non-idempotent ones
(actor_duplicate-like, *_add_*, *_remove_*, *_delete_*, *_create_*, spawn) to
`NON_IDEMPOTENT`.

**Acceptance:** ≈55 new first-class tools registered exactly once each;
`get_tool_signature` returns real param docs for a sample of them (unit tests:
pick 3 diverse commands — e.g. `spline_add_point`, `level_save`, `mesh_extract`
— assert descriptor presence, schema fields incl. optionality, and handler
dispatch via a mocked sender); no duplicate names vs existing tools (unit test
over the full merged list); lint green; tsc clean; vitest green.

## Task 2 — Actor-domain P0 python tools via the pyTemplate factory  [TS]

**Files:** new `src/tools/actor/actor-py-tools.ts` (+ test); `index.ts`.

**Change:** implement the actor-level-editing P0s from the roadmap catalog that
are NOT already covered by existing tools or Task 1's surfaced commands. Check
overlap first (grep existing + sidecar). Candidates (from
`docs/plans/2026-06-28-mcp-supertooling-tools.json` actor-level-editing P0s):
`actor_inspect` (full read-back: transform/class/components/properties/bounds),
`actor_find` (query by name/class/tag/spatial), `actor_get_selection` /
`actor_set_selection`, `actor_spawn_from_asset` (asset path → placed actor,
snap_to_floor), `actor_focus` (pilot viewport to actor), `actor_batch_transform`
(many actors, one call), `actor_set_folder` / hierarchy ops. Each is a
`PyToolDescriptor` (schema + buildScript emitting HAYBA_JSON via _emit/_err)
registered through `toToolDescriptor` into the descriptor list, exactly like
Task 8's migration. Inspection-first: every write tool gets a read-back field
in its return. Python uses `unreal.get_editor_subsystem(unreal.EditorActorSubsystem)`
+ reflection — mirror the validated accessor patterns in `pcg-primitives.ts`.

**Acceptance:** 6-10 net-new actor tools registered once each with correct
signatures (unit tests with mocked sender: param validation + script generation
+ HAYBA_JSON parsing per tool); no name collisions; non-idempotent ones
(spawn_from_asset) in NON_IDEMPOTENT; tsc clean; vitest green; lint green.

## Task 3 — Live-editor validation of Wave 1  [live smoke]

Run a smoke against the running editor (TCP script pattern from the Phase 0/1
smoke): call `get_tool_signature` for 5 surfaced commands; execute 3 read-only
surfaced commands (e.g. `level_info`-like, `mesh_topology_stats`-like,
`actor_*` read) and 2 python-backed actor reads (`actor_inspect`,
`actor_find`); verify structured results. Destructive calls stay plan-gated.
Record results in the ledger.
