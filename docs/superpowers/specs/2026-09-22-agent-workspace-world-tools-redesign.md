# Agent Workspace and World Tools Redesign

**Date:** 2026-09-22
**Status:** Approved; foundation implemented. See `docs/updates/2026-09-22.md` for verification, rollout status, and remaining scope.
**Supersedes:** The five-noun information architecture in `docs/design/2026-08-23-extension-redesign/02-PLAN.md` and Track P2 in `03-MASTER-PLAN.md`

## Purpose

Hayba currently exposes implementation details as product navigation: Chat, MCP, Slivers, Tool Stream, Scene Map, Plan, Diff, Validation, Library, Lessons, and Settings. Users must understand the internal subsystem before they can decide where to go.

This redesign makes the in-editor experience chat-first and reduces the product to three destinations:

1. **Agent** — ask for work, understand what is happening, review changes, and approve risky actions.
2. **World** — inspect the current world, its streaming structure, and contextual findings.
3. **Library** — find assets, profiles, and reusable recipes.

Settings remains accessible through a gear and is not peer navigation.

The same simplification applies to tools. Landscape import stops being a narrow one-off and becomes a workflow exposed through general world-ingestion and asset-preparation operations. World Partition, data layers, HLOD, Nanite, collision, LODs, materials, and validation become optional capabilities of those workflows rather than separate user-facing tool families.

## Product principles

- **Chat is the operating surface.** Plans, execution, approvals, tool traces, diffs, and results appear in the conversation that caused them.
- **One action produces one result.** A multi-tool workflow renders as one activity card with expandable internal steps.
- **Specialists are implementation details.** Users talk to one coordinator. Specialist agents may execute work, but do not create separate rooms or navigation.
- **Progressive disclosure.** Default views show intent, current state, and outcome. Raw calls, payloads, logs, and diagnostics are available on demand.
- **Capabilities compose.** Tools describe operations and optional capabilities, not individual UI features.
- **Truth over breadth.** Unsupported capabilities are reported during inspection and are never silently skipped or advertised as available.
- **Every mutation has trust affordances.** Destructive steps remain Plan Mode gated, transactional where Unreal supports transactions, and explicit about anything that cannot be undone.
- **One vocabulary.** Enum names, UI labels, icon keys, docs, events, and onboarding use Agent, World, Library, and Settings consistently.

## Information architecture

### Agent

Agent is the default and primary destination. It owns:

- persistent conversations;
- streaming assistant responses;
- current editor selection and attached context;
- task planning and Plan Mode approval;
- live execution progress;
- diffs and proposed source patches;
- tool and specialist-agent traces;
- validation verdicts caused by the task;
- retry, repair, undo, and save-as-recipe actions.

Plan, Diff, and Tool Stream cease to exist as standalone panels. Their information becomes an **activity card** inside the conversation.

An activity card has five states: `planning`, `awaiting_approval`, `running`, `succeeded`, and `failed`. Cancelled work is represented as a terminal result rather than a sixth in-progress state. The collapsed card shows task name, state, elapsed time, concise outcome, and the most relevant action. Expanding it reveals steps, tools, agent labels, diffs, diagnostics, validation, and timing.

The coordinator automatically selects specialist agents using declared capability filters. A compact selector lets advanced users pin a specialist for the next message. `/agent <name>` provides the keyboard equivalent. Specialist labels appear only in expanded execution details.

### World

World owns the state of the open Unreal world rather than the history of how it was changed. It includes:

- the web-based scene map;
- selected actor and asset context;
- landscape and terrain summaries;
- World Partition grid, streaming source, cell, data-layer, and HLOD status;
- contextual rule violations and directional repair suggestions;
- import readiness and last-ingestion summary.

The web scene-map renderer is retained. The native `SCanvas` scene map is deleted. If the WebBrowser plugin is unavailable, World shows an explicit fallback with a concise textual world summary and setup action rather than a blank panel.

Validation, Lessons, and the separate PLUMB surface cease to exist as standalone panels. A finding lives beside the world object or operation that produced it. Explanations are attached to findings, not stored in a separate Lessons destination.

### Library

Library owns reusable inputs:

- project and external assets;
- Profiles, which define desired world properties or constraints;
- Recipes, which repeat reviewed workflows;
- recent imports and saved searches.

Slivers are renamed to Recipes. Old MCP names may remain as deprecated aliases for one release, but the old word must disappear from user-facing copy. Memory is not a user-facing noun. Relevant memory is retrieved by the coordinator and may be inspected from conversation details for debugging.

### Settings

Settings owns connection status, provider configuration, model selection, MCP clients, capabilities, safety, and diagnostics. The MCP panel is absorbed here. Connection and model status remain visible in the Agent footer and deep-link to the relevant Settings section.

## Generalized tool model

### Design

The tool surface is organized around two composable workflows and focused inspection primitives:

- `world_inspect`
- `world_ingest`
- `world_validate`
- `asset_inspect`
- `asset_prepare`

Existing narrow tools remain as compatibility wrappers until their callers and recipes migrate. They delegate to the same internal services and return the same envelope.

### `world_inspect`

Returns a capability and readiness report for the open world. It does not mutate.

It reports:

- world type and current level;
- existing landscape actors and bounds;
- World Partition enabled state and runtime grid configuration;
- data layers and HLOD layers;
- coordinate system, scale, and source-control/save readiness;
- relevant plugin and engine feature availability;
- blocking errors, warnings, and recommended defaults.

This inspection result is the required first stage of `world_ingest`; callers do not need to invoke it separately.

### `world_ingest`

Imports or updates world-scale content through a staged request:

```ts
type WorldIngestRequest = {
  source: WorldSource;
  destination: WorldDestination;
  terrain?: TerrainOptions;
  partition?: PartitionOptions;
  assets?: AssetPreparationPolicy;
  materials?: MaterialPolicy;
  validation?: ValidationPolicy;
  execution?: ExecutionPolicy;
};
```

`source` is discriminated and supports heightmaps, landscape exports, mesh terrain, and connector-produced artifacts without placing provider-specific fields at the top level. `destination` distinguishes creating a world, adding to the open world, and updating a previously managed import.

The workflow stages are:

1. inspect source and destination;
2. normalize dimensions, units, axes, tiling, and formats;
3. produce a dry-run plan with capability availability and irreversible steps;
4. create or update terrain/world assets;
5. apply optional World Partition, data-layer, and HLOD configuration;
6. prepare imported meshes and material sets;
7. save and verify assets;
8. validate the resulting world;
9. return one structured workflow result.

Each stage records status, duration, affected objects, warnings, and remediation actions. A stage may be `skipped` only when it was not requested or is explicitly inapplicable. Missing support is `unsupported`, not `skipped`.

### World Partition coverage

Partition configuration is policy-driven rather than a collection of booleans:

```ts
type PartitionOptions =
  | { mode: 'preserve' }
  | { mode: 'configure'; runtimeGrid?: RuntimeGridPolicy; dataLayers?: DataLayerPolicy; hlod?: HlodPolicy }
  | { mode: 'require'; runtimeGrid?: RuntimeGridPolicy; dataLayers?: DataLayerPolicy; hlod?: HlodPolicy };
```

- `preserve` leaves existing configuration untouched.
- `configure` applies supported settings and reports unavailable ones.
- `require` fails before mutation if the requested configuration cannot be satisfied.

Defaults derive from source extent and project settings and are always included in the dry-run plan. The first release does not invent automatic grid tuning beyond documented heuristics; it exposes its calculated values for review.

### `asset_prepare`

Normalizes assets for their intended use rather than exposing Nanite as an isolated feature:

```ts
type AssetPreparationPolicy = {
  intent: 'environment' | 'hero' | 'foliage' | 'terrain' | 'custom';
  nanite?: 'preserve' | 'auto' | 'enable' | 'disable';
  collision?: 'preserve' | 'auto' | 'simple' | 'complex' | 'none';
  lods?: 'preserve' | 'auto' | LodPolicy;
  lightmapUvs?: 'preserve' | 'generate' | 'require';
  materialInstances?: 'preserve' | 'create' | 'require';
};
```

`auto` decisions are returned with reasons. For example, Nanite is not enabled blindly for every mesh; eligibility, mesh role, deformation, material constraints, and engine support contribute to the verdict. `require`-style policies fail before mutation when their postcondition cannot be verified.

`asset_inspect` exposes the same eligibility and readiness logic without mutation. Landscape ingestion may call `asset_prepare` internally for mesh tiles, proxy meshes, foliage, and imported environment assets.

### Common workflow result

All generalized workflows return:

```ts
type WorkflowResult = {
  ok: boolean;
  operationId: string;
  summary: string;
  stages: WorkflowStageResult[];
  affectedResources: ResourceRef[];
  verdicts: DirectionalVerdict[];
  undo?: UndoDescriptor;
  remediation: RemediationAction[];
};
```

This is the shared contract consumed by Agent activity cards, World summaries, Recipes, logs, and external MCP clients.

## Agent architecture

The C++ Slate UI remains a thin client. The TypeScript sidecar owns conversation persistence, model/provider adapters, orchestration, specialist selection, tool dispatch, and normalized event streaming.

The coordinator receives one tool catalog derived from the canonical descriptors. Specialists are configurations over that catalog: system guidance, allowed capability tags, and memory scope. They do not register parallel copies of tools.

The event stream uses semantic frames:

- `message_delta`
- `activity_started`
- `activity_step`
- `approval_requested`
- `artifact_proposed`
- `verdict_emitted`
- `activity_completed`
- `error`

The UI must not infer workflow state by parsing human-readable tool output. Existing SSE transport may carry these frames; transport replacement is out of scope.

Conversation persistence stores messages, compact activity summaries, artifact references, and provider-neutral usage metadata. Raw secrets and unredacted tool arguments are never persisted. Existing central secret-redaction and hash-only journal invariants remain unchanged.

## UI and visual language

### Layout

- A narrow left rail contains Agent, World, and Library.
- A gear is anchored at the bottom.
- Agent uses a single-column conversation with a sticky composer.
- Activity cards use a compact summary row and progressive disclosure.
- World uses a map-first layout with an inspector drawer for selection, partition, and findings.
- Library uses searchable grouped results with asset/recipe/profile filters, not separate sub-apps.

The layout must remain useful at dock widths from 360 px upward. At narrow widths the rail becomes icon-only; labels remain available through tooltips and accessible names.

### Icons

The icon set is redrawn on a shared 24 px keyline grid with one outline weight, rounded joins, and comparable optical mass. Required navigation glyphs are Agent, World, Library, and Settings. Shared state marks are attention, pending, and unsaved.

Icons inherit foreground color. They do not contain baked cream fills. Ochre `#C47A28` is reserved for active navigation, pending approval, unsaved edits, and actionable violations. Success and failure use semantic colors plus shape/text so meaning never depends on color alone.

### Accessibility

- Interactive targets are at least 32×32 Unreal logical pixels.
- Keyboard focus, activation, expansion, approval, cancellation, and navigation are supported.
- Icon-only controls have tooltips and accessible text.
- Activity state is expressed by label and icon in addition to color.
- Streaming updates do not steal focus or force scrolling when the user has moved away from the bottom.
- Destructive approval states state the scope and reversibility in text.

## Migration and deletion

The implementation migrates behavior before deleting surfaces:

1. Introduce shared activity and world models independent of Slate widgets.
2. Adapt Chat, Plan, Diff, and Tool Stream producers to the activity model.
3. Build Agent against the model and migrate chat persistence.
4. Build World around the web scene map and contextual verdict model.
5. Merge asset/profile/recipe sources into Library.
6. Switch main navigation to Agent, World, and Library.
7. Delete superseded standalone panels and the native scene-map renderer.
8. Remove old user-facing names and update onboarding/docs.

Compatibility aliases for existing MCP tool names are permitted for one release and must emit deprecation metadata. UI panel compatibility is not retained; there is one new shell.

## Error handling and trust

- Inspection and dry-run errors occur before mutation wherever possible.
- Partial failures identify exactly which stages and resources succeeded.
- Retrying resumes only when a stage declares itself idempotent; otherwise a new plan is produced.
- Mutating stages use existing Unreal transactions where supported.
- Non-transactional operations, including some build, source-control, and external-file effects, are labeled before approval.
- Connection loss leaves an activity in a recoverable unknown state until status is reconciled; it is never rendered as success.
- Unsupported engine/plugin capabilities return stable machine-readable codes and a user-facing remediation action.

## Testing strategy

### TypeScript

- Contract tests for request discriminators and `WorkflowResult`.
- Stage orchestration tests for success, unsupported capability, partial failure, cancellation, and retry.
- Tool-compatibility tests proving old landscape wrappers delegate without semantic drift.
- Agent-loop tests for specialist selection, capability filtering, approvals, and semantic event order.
- Persistence and redaction tests proving secrets and raw sensitive arguments are absent.

### Unreal/C++

- Automation tests for navigation vocabulary and panel ownership.
- Model tests for activity state transitions and reconnection reconciliation.
- Handler tests for World Partition inspection/configuration and asset-preparation policies on supported engine versions.
- Slate tests for keyboard navigation, narrow-width behavior, and fallback states.
- Build checks ensuring deleted panels are no longer registered or referenced.

### End-to-end

Golden workflows cover:

1. import a tiled heightmap into a partitioned world;
2. update an existing managed landscape without replacing unrelated settings;
3. import mesh terrain and automatically prepare eligible meshes for Nanite;
4. require an unsupported capability and verify that no mutation occurs;
5. approve a plan in Agent, observe one activity card, inspect the result in World, and save it as a Recipe in Library;
6. disconnect during execution and reconcile the final state after reconnect.

## Acceptance criteria

- The sidebar contains exactly Agent, World, and Library; Settings is a gear.
- There are no standalone Plan, Diff, Tool Stream, Validation, Lessons, MCP, Slivers, or Memory panels.
- The native scene-map implementation is removed; World has a functional textual fallback when WebBrowser is unavailable.
- One conversation can plan, request approval, execute through specialist agents, show diffs/verdicts, and offer retry/undo without navigating away.
- Landscape ingestion can explicitly inspect and configure World Partition, data layers, and HLOD using preserve/configure/require semantics.
- Imported mesh preparation covers Nanite, collision, LOD, lightmap UV, and material-instance policy with inspectable decisions.
- Existing landscape/import names either delegate to the generalized workflows with deprecation metadata or are removed with a documented migration.
- All workflow consumers use the same structured result and directional-verdict contracts.
- No user-facing text uses “Sliver,” “Tool Stream,” “Validation Report,” or “Memory Inspector.”
- Icons share one grid, stroke system, state vocabulary, and semantic color policy.
- Existing Plan Mode, transaction, redaction, and hash-only journal guarantees remain intact.

## Explicitly out of scope

- Giving the in-editor agent unrestricted filesystem write access.
- Replacing SSE or the Node sidecar solely for architectural cleanliness.
- Adding separate UIs for every specialist agent.
- Automatically enabling Nanite or World Partition without inspection and an explicit policy.
- Building new external asset-provider integrations as part of this redesign.
- Chasing competitor tool-count parity.

## Implementation boundaries

This work should be delivered in reviewable slices:

1. shared contracts and models;
2. generalized inspection and workflow orchestration;
3. Agent consolidation;
4. World consolidation;
5. Library consolidation;
6. navigation, icons, and visual-token sweep;
7. compatibility cleanup and panel deletion;
8. end-to-end verification.

The implementation plan must identify current dirty-worktree overlap before assigning files. It must preserve unrelated edits in `asset-delete`, `heavy-ops`, tool registration/executor tests, and the Unreal asset handler/guard unless those changes are explicitly incorporated after review.
