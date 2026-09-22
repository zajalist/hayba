# Generalized World Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrow landscape-import surface with inspectable, policy-driven world and asset workflows covering World Partition and Nanite while preserving compatibility aliases.

**Architecture:** Add pure TypeScript contracts and orchestration first, then small Unreal commands for facts or mutations that cannot be expressed safely through existing commands. Each workflow returns one `WorkflowResult`; legacy landscape entry points adapt into it rather than owning another path.

**Tech Stack:** TypeScript 7, Zod 4, Vitest 4, MCP SDK, Unreal Engine C++ editor modules

**Spec:** `docs/superpowers/specs/2026-09-22-agent-workspace-world-tools-redesign.md`

## Global Constraints

- Preserve Plan Mode, Unreal transactions, central secret redaction, and the hash-only journal.
- `preserve`, `configure`, and `require` are the only World Partition policy modes.
- Missing requested support is `unsupported`, never silently `skipped`.
- Nanite decisions must be inspectable and may not default to blindly enabling every mesh.
- Existing unrelated changes in `src/tools/heavy-ops.ts`, `src/tools/index.ts`, `HaybaMCPAssetHandler.cpp`, and `HaybaMCPAssetGuard.h` must be preserved and reviewed before overlap is edited.
- Node.js remains `>=22.5.0`; add no runtime dependency.

---

### Task 1: Workflow contracts and result builders

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/workflows/contracts.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/workflows/contracts.test.ts`

**Interfaces:**
- Produces: `WorldIngestRequestSchema`, `AssetPreparationPolicySchema`, `WorkflowResultSchema`, `stageResult()`, `unsupportedStage()`.
- Produces: inferred `WorldIngestRequest`, `AssetPreparationPolicy`, `WorkflowResult`, and `WorkflowStageResult` types.

- [ ] **Step 1: Write failing schema tests**

```ts
it('rejects an unknown partition mode', () => {
  expect(() => WorldIngestRequestSchema.parse({
    source: { kind: 'heightmap', path: 'D:/terrain.r16' },
    destination: { mode: 'open_world' },
    partition: { mode: 'automatic' },
  })).toThrow();
});

it('represents unsupported separately from skipped', () => {
  expect(unsupportedStage('partition', 'world_partition_unavailable').status)
    .toBe('unsupported');
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `npm test -- src/tools/workflows/contracts.test.ts` from `mcp-tools/hayba-mcp`
Expected: FAIL because the contracts module does not exist.

- [ ] **Step 3: Implement the discriminated contracts**

Define source kinds `heightmap`, `landscape_export`, `mesh_terrain`, and `connector_artifact`; destination modes `open_world`, `new_world`, and `managed_update`; stage statuses `pending`, `running`, `succeeded`, `failed`, `skipped`, and `unsupported`. Define `WorkflowResult` exactly as the spec and use `.strict()` on all public request objects.

```ts
export const PartitionOptionsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preserve') }).strict(),
  z.object({ mode: z.literal('configure'), runtimeGrid: RuntimeGridPolicySchema.optional(), dataLayers: DataLayerPolicySchema.optional(), hlod: HlodPolicySchema.optional() }).strict(),
  z.object({ mode: z.literal('require'), runtimeGrid: RuntimeGridPolicySchema.optional(), dataLayers: DataLayerPolicySchema.optional(), hlod: HlodPolicySchema.optional() }).strict(),
]);
```

- [ ] **Step 4: Run contract tests and typecheck**

Run: `npm test -- src/tools/workflows/contracts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add mcp-tools/hayba-mcp/src/tools/workflows/contracts.ts mcp-tools/hayba-mcp/src/tools/workflows/contracts.test.ts
git commit -m "feat(world): define generalized workflow contracts"
```

### Task 2: Pure world-inspection normalization

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-inspect.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-inspect.test.ts`

**Interfaces:**
- Consumes: `WorkflowStageResult` from Task 1.
- Produces: `WorldFacts`, `WorldCapabilityReport`, `normalizeWorldFacts(raw: unknown): WorldCapabilityReport`, and `worldInspectDescriptor`.

- [ ] **Step 1: Write failing normalization tests**

Cover a partitioned world, a non-partitioned world, missing WebBrowser/WorldPartition support, and malformed UE output. Assert stable capability codes such as `world_partition_unavailable` and `hlod_unavailable`.

- [ ] **Step 2: Run the focused test**

Run: `npm test -- src/tools/world/world-inspect.test.ts`
Expected: FAIL because `world-inspect.ts` does not exist.

- [ ] **Step 3: Implement normalization and descriptor**

The descriptor calls a single UE command named `world_inspect`. Normalization must never infer support from prose; consume boolean fields and arrays, return `blockingErrors`, `warnings`, and `recommendedDefaults` explicitly.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- src/tools/world/world-inspect.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add mcp-tools/hayba-mcp/src/tools/world/world-inspect.ts mcp-tools/hayba-mcp/src/tools/world/world-inspect.test.ts
git commit -m "feat(world): add normalized world inspection"
```

### Task 3: Native world inspection command

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPWorldPartitionHandler.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPWorldPartitionHandler.h`
- Modify: `mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPWorldInspectTest.cpp`

**Interfaces:**
- Produces wire command `world_inspect` returning `{world, landscape, partition, data_layers, hlod, capabilities, save_ready}`.
- Consumed by: `worldInspectDescriptor` from Task 2.

- [ ] **Step 1: Add a failing automation test**

Create an editor world without World Partition and assert `partition.enabled == false`, capability booleans are present, and landscape/data-layer arrays are valid empty arrays rather than omitted.

- [ ] **Step 2: Build the plugin test target and confirm failure**

Run the repository's documented Unreal automation build command from `unreal/HaybaMCPToolkit/README.md`; filter `Hayba.MCP.WorldInspect`.
Expected: FAIL because `world_inspect` is not registered.

- [ ] **Step 3: Implement one read-only snapshot command**

Use the existing World Partition handler and parameter/result helpers. Do not load or save assets. Report engine feature availability with explicit booleans. Register the command through the same `GetCommands()` path as neighboring world-partition commands and add its sidecar schema.

- [ ] **Step 4: Run the automation test and sidecar contract tests**

Run: the focused Unreal automation test, then `npm test -- src/tools/legacy-tool-factory.test.ts` from the MCP package.
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json
git commit -m "feat(world): expose partition-aware world inspection"
```

### Task 4: Asset eligibility and preparation policy

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset/asset-prepare.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset/asset-prepare.test.ts`

**Interfaces:**
- Consumes: `AssetPreparationPolicy`, `WorkflowResult`, and existing `executeCommand`.
- Produces: `inspectAssetPreparation(input)`, `prepareAsset(input)`, `assetInspectDescriptor`, and `assetPrepareDescriptor`.

- [ ] **Step 1: Write failing decision-table tests**

Test at minimum: a static environment mesh eligible for Nanite under `auto`; a foliage/deforming mesh preserved under `auto`; `enable` rejected when native inspection says unsupported; `require`-style lightmap/material policies fail before mutation; and collision/LOD `preserve` emits no mutation calls.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- src/tools/asset/asset-prepare.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement inspect-then-apply orchestration**

Call existing mesh inspection and static-mesh mutation commands where available. Return each automatic decision as `{capability, requested, resolved, reason}`. Keep command names behind a local adapter so native command changes do not leak into workflow contracts.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- src/tools/asset/asset-prepare.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add mcp-tools/hayba-mcp/src/tools/asset/asset-prepare.ts mcp-tools/hayba-mcp/src/tools/asset/asset-prepare.test.ts
git commit -m "feat(asset): add inspectable preparation policies"
```

### Task 5: Staged world-ingest orchestrator

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-ingest.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-ingest.test.ts`

**Interfaces:**
- Consumes: `worldInspectDescriptor`, `prepareAsset`, existing `landscape_import`, and Task 1 contracts.
- Produces: `runWorldIngest(request, dependencies): Promise<WorkflowResult>` and `worldIngestDescriptor`.

- [ ] **Step 1: Write failing orchestration tests**

Use injected fake dependencies. Assert stage order; dry-run performs no mutations; `require` stops before import when partition support is absent; `configure` records unsupported optional HLOD and continues; partial failures retain affected resources; and cancellation stops before the next stage.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- src/tools/world/world-ingest.test.ts`
Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement the stage runner**

Implement explicit stage functions named `inspect`, `normalize`, `plan`, `terrain`, `partition`, `assets`, `saveVerify`, and `validate`. Each returns `WorkflowStageResult`; the coordinator assembles one `WorkflowResult`. Dependencies are passed as an interface so tests never touch UE.

- [ ] **Step 4: Run workflow tests and typecheck**

Run: `npm test -- src/tools/world/world-ingest.test.ts src/tools/asset/asset-prepare.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add mcp-tools/hayba-mcp/src/tools/world/world-ingest.ts mcp-tools/hayba-mcp/src/tools/world/world-ingest.test.ts
git commit -m "feat(world): orchestrate staged world ingestion"
```

### Task 6: Registration and compatibility wrapper

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/heavy-ops.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/landscape-import.test.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-workflow-registration.test.ts`

**Interfaces:**
- Consumes: descriptors from Tasks 2, 4, and 5.
- Produces registered MCP tools `world_inspect`, `world_ingest`, `asset_inspect`, and `asset_prepare`.
- Preserves `hayba_import_landscape` and `import_landscape` as deprecated adapters for one release.

- [ ] **Step 1: Snapshot the user changes in overlapping files**

Run: `git diff -- mcp-tools/hayba-mcp/src/tools/index.ts mcp-tools/hayba-mcp/src/tools/heavy-ops.ts`
Save no new file; read the diff and ensure the registration edit does not replace or revert it.

- [ ] **Step 2: Write failing registration and compatibility tests**

Assert all four generalized descriptors appear once, `world_ingest` is heavy, and the legacy landscape handler maps its old fields into `source.kind='heightmap'`, `destination.mode='open_world'`, and `partition.mode='preserve'`. Assert the legacy response includes deprecation metadata and the new `operationId`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm test -- src/tools/world/world-workflow-registration.test.ts src/tools/landscape-import.test.ts`
Expected: FAIL because the descriptors are not registered and the old wrapper does not delegate.

- [ ] **Step 4: Register descriptors and adapt the legacy importer**

Import descriptor barrels into `index.ts` without adding duplicate schemas. Add `world_ingest` to heavy-operation metadata. Keep the existing native `landscape_import` command as the terrain stage implementation; do not introduce a second importer.

- [ ] **Step 5: Run package verification**

Run: `npm test -- src/tools/world src/tools/asset/asset-prepare.test.ts src/tools/landscape-import.test.ts && npm run typecheck && npm run lint:legacy-wrappers`
Expected: PASS.

- [ ] **Step 6: Commit only reviewed workflow files**

```powershell
git add -p mcp-tools/hayba-mcp/src/tools/index.ts mcp-tools/hayba-mcp/src/tools/heavy-ops.ts
git add mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts mcp-tools/hayba-mcp/src/tools/landscape-import.test.ts mcp-tools/hayba-mcp/src/tools/world/world-workflow-registration.test.ts
git commit -m "feat(world): register workflows and preserve import aliases"
```

### Task 7: End-to-end contract verification and documentation

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/world/world-ingest.contract.test.ts`
- Modify: `docs/wiki/MCP-Tool-Reference.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: public descriptors and the mocked UE executor.
- Produces: executable contract coverage for the complete generalized workflow surface.

- [ ] **Step 1: Add contract tests for the six golden failure/success paths applicable without a live editor**

Cover tiled heightmap request shape, managed update preservation, mesh terrain plus Nanite preparation, unsupported `require` with zero mutations, structured partial failure, and cancellation.

- [ ] **Step 2: Run the contract test**

Run: `npm test -- src/tools/world/world-ingest.contract.test.ts`
Expected: PASS after Tasks 1–6; failures indicate integration drift to correct before docs.

- [ ] **Step 3: Document exact tools, policies, and migration**

Document the four generalized tools, policy enums, dry-run behavior, one heightmap example, one mesh-terrain/Nanite example, and the one-release deprecation of landscape aliases. Do not claim live capabilities not covered by native handlers and tests.

- [ ] **Step 4: Run complete MCP verification**

Run: `npm test && npm run typecheck && npm run build:server` from `mcp-tools/hayba-mcp`.
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add mcp-tools/hayba-mcp/src/tools/world/world-ingest.contract.test.ts docs/wiki/MCP-Tool-Reference.md CHANGELOG.md
git commit -m "docs(world): publish generalized ingestion workflow"
```
