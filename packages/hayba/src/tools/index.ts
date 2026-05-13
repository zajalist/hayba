import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { appendMeta } from './hayba-tool-meta.js';
import { recordSchema, type Cost } from './schema-registry.js';
import { installToolStreamMirror } from './tool-stream-mirror.js';

// ── Code Mode meta-tools (always-on) ──────────────────────────────────────────
import { listToolCategoriesHandler, meta as listMeta } from './code-mode/list-tool-categories.js';
import { getToolSignatureHandler, meta as sigMeta } from './code-mode/get-tool-signature.js';
import { pythonRunHandler, meta as pyMeta } from './python/python-run.js';

// ── New UE-domain tool handlers ───────────────────────────────────────────────
import { actorSpawnHandler, meta as actorSpawnMeta } from './actor/actor-spawn.js';
import { actorListHandler, meta as actorListMeta } from './actor/actor-list.js';
import { actorDeleteHandler, meta as actorDeleteMeta } from './actor/actor-delete.js';
import { actorTransformHandler, meta as actorTransformMeta } from './actor/actor-transform.js';
import { sceneExportHandler, meta as sceneExportMeta } from './scene/scene-export.js';
import { sceneValidatePhysicsHandler, meta as scenePhysicsMeta } from './scene/scene-validate-physics.js';
import { editorCaptureViewportHandler, meta as captureMeta } from './editor/editor-capture-viewport.js';
import { editorStartPieHandler, meta as pieMeta } from './editor/editor-start-pie.js';
import { editorStreamLogHandler, meta as streamLogMeta } from './editor/editor-stream-log.js';
import { editorGetPerfStatsHandler, meta as perfStatsMeta, schema as perfStatsSchema } from './perf/editor-get-perf-stats.js';
import { textureAuditHandler, meta as textureAuditMeta, schema as textureAuditSchema } from './perf/texture-audit.js';
import { meshAuditHandler, meta as meshAuditMeta, schema as meshAuditSchema } from './perf/mesh-audit.js';

// ── PCGEx tool handlers ───────────────────────────────────────────────────────
import { searchNodeCatalog } from './search-node-catalog.js';
import { getNodeDetails } from './get-node-details.js';
import { createPcgGraph } from './create-pcg-graph.js';
import { validatePcgGraph } from './validate-pcg-graph.js';
import { listPcgAssets } from './list-pcg-assets.js';
import { exportPcgGraph } from './export-pcg-graph.js';
import { executePcgGraph } from './execute-pcg-graph.js';
import { checkUeStatus } from './check-ue-status.js';
import { scrapeNodeRegistry, type ScrapeNodeRegistryParams } from './scrape-node-registry.js';
import { matchPinNames } from './match-pin-names.js';
import { validateAttributeFlow, type ValidateAttributeFlowParams } from './validate-attribute-flow.js';
import { diffAgainstWorkingAsset, type DiffAgainstWorkingAssetParams } from './diff-against-working-asset.js';
import { formatGraphTopology, type FormatGraphTopologyParams } from './format-graph-topology.js';
import { abstractToSubgraph, type AbstractToSubgraphParams } from './abstract-to-subgraph.js';
import { parameterizeGraphInputs } from './parameterize-graph-inputs.js';
import { queryPcgexDocs, type QueryPcgexDocsParams } from './query-pcgex-docs.js';
import { initiateInfrastructureBrainstorm } from './initiate-infrastructure-brainstorm.js';

import {
  definePhonology,
  definePhonologySchema,
  generateNameSchema,
  languageApplySoundChanges,
  languageGenerateName,
  languageProposeDerivation,
  languageRemixPhonologies,
  languageWordFor,
  proposeDerivationSchema,
  remixPhonologiesSchema,
  soundChangesSchema,
  wordForSchema,
} from './worldbuilding/language-handlers.js';
import {
  dynamoSchema,
  escapeSchema,
  hzSchema,
  planetDynamoField,
  planetEscapeRegime,
  planetHabitableZone,
  planetStabilityReportPayload,
  planetTidalLocking,
  tidalSchema,
} from './worldbuilding/planet-handlers.js';

// ── Zone painter tool handlers ────────────────────────────────────────────────
import { openZonePainterHandler } from './hayba-open-zone-painter.js';
import { readZonesHandler } from './hayba-read-zones.js';
import { setPainterHeightmapHandler } from './hayba-set-painter-heightmap.js';

// ── Conventions tool handlers ─────────────────────────────────────────────────
import { setupConventionsHandler } from './hayba-setup-conventions.js';
import { analyzeConventionsHandler } from './hayba-analyze-conventions.js';

// SessionManager (Gaea session) parked while terrain features are off — kept
// as a typed shim so registerTools' signature doesn't churn for callers.
type SessionManagerStub = Record<string, unknown>;

export function registerTools(server: McpServer, session: SessionManagerStub): void {

  // Wrap server.tool BEFORE any registration so every tool is captured in the
  // UE Tool Stream panel, including pure TS-side handlers (PCGEx catalog, etc).
  installToolStreamMirror(server);

  // Record every Zod shape into the schema registry so get_tool_signature can
  // derive parameter docs from the actual validation schema — independent of
  // whether the tool is also eagerly registered with server.tool() under
  // Code Mode. The registry is the source of truth; the hand-maintained dict
  // in get-tool-signature.ts is only a fallback for un-migrated tools.
  const reg = (name: string, shape: z.ZodRawShape, cost: Cost, returns: string) =>
    recordSchema(name, { shape, cost, returns });

  // ──────────────────────────────────────────────────────────────────────────
  // Code Mode meta-tools — always registered. Per the HaybaOS spec (§2.4),
  // these are Claude's progressive-discovery entry points.
  //   list_tool_categories  → returns domain list + command counts
  //   get_tool_signature    → returns the JSON schema for a specific command
  //   python_run            → executes any command via UE Python (escape hatch)
  // ──────────────────────────────────────────────────────────────────────────

  server.tool(
    'hayba_propose_plan',
    'Propose a step-by-step plan to the user before performing destructive operations. Required when Plan Mode is on. Steps may be strings or {title, description, tool} objects.',
    {
      steps: z.array(z.union([
        z.string(),
        z.object({
          title: z.string(),
          description: z.string().optional(),
          tool: z.string().optional(),
        }),
      ])).describe('Ordered list of plan steps'),
      await_seconds: z.number().int().min(0).max(600).optional()
        .describe('How long the agent will wait for human approval (informational; default 30)'),
    },
    async (params) => {
      try {
        const { ensureConnected } = await import('../tcp-client.js');
        const c = await ensureConnected();
        const res = await c.send('hayba_propose_plan', params as Record<string, unknown>, 5000);
        return {
          content: [{ type: 'text', text: JSON.stringify(res.data ?? { ok: res.ok }, null, 2) }],
          isError: !res.ok,
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error pushing plan to UE: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'list_tool_categories',
    appendMeta('List all HaybaOS command domains and their commands. Call this first to discover what is available before requesting a specific schema.', listMeta),
    {},
    async () => {
      const r = await listToolCategoriesHandler({}, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'get_tool_signature',
    appendMeta('Return the JSON schema (params, return shape, cost) for a specific HaybaOS command. Call list_tool_categories first to find command names.', sigMeta),
    { command: z.string().describe('Exact command name, e.g. "actor_spawn"') },
    async (params) => {
      const r = await getToolSignatureHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'python_run',
    appendMeta('Execute a Python script inside UE via PythonScriptPlugin. Universal escape hatch for invoking any UE command not otherwise exposed.', pyMeta),
    {
      script: z.string().describe('Python source to execute'),
      allow_unsafe: z.boolean().optional().describe('Override Tier 3 filesystem/subprocess block (DANGEROUS)'),
    },
    async (params) => {
      const r = await pythonRunHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  // Record schemas for tools whose shapes we want get_tool_signature to derive
  // live. Runs regardless of Code Mode so the registry stays in sync.
  recordEagerSchemas(reg);

  // When Code Mode is ON (default), stop here — full schemas are only fetched
  // on demand via get_tool_signature. Set HAYBA_CODE_MODE=off to expose
  // every tool eagerly (~70 tools, much larger initial tool-list payload).
  if (config.codeMode) return;

  // ──────────────────────────────────────────────────────────────────────────
  // Eager registrations (Code Mode disabled) — every domain tool below here.
  // ──────────────────────────────────────────────────────────────────────────

  // ── Actor domain ────────────────────────────────────────────────────────────

  const vec3 = z.tuple([z.number(), z.number(), z.number()]);

  // Some MCP clients (incl. Claude Code's tool harness) JSON-stringify nested
  // arrays/booleans before they hit Zod. Wrap so we accept both raw and the
  // stringified form for params we know are commonly affected.
  const coerceBool = z.preprocess(
    (v) => typeof v === 'string' ? v.toLowerCase() === 'true' : v,
    z.boolean()
  );
  const coerceVec3 = z.preprocess((v) => {
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }, vec3);

  server.tool(
    'actor_spawn',
    appendMeta('Spawn a new actor in the active level.', actorSpawnMeta),
    {
      class_path: z.string().describe('UE class path, e.g. "/Script/Engine.StaticMeshActor"'),
      location: coerceVec3.optional(),
      rotation: coerceVec3.optional(),
      scale: coerceVec3.optional(),
      label: z.string().optional(),
    },
    async (params) => {
      const r = await actorSpawnHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'actor_list',
    appendMeta('Enumerate actors in the active level.', actorListMeta),
    {
      class_filter: z.string().optional().describe('Exact class name filter'),
      tag: z.string().optional().describe('Tag filter'),
    },
    async (params) => {
      const r = await actorListHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'actor_delete',
    appendMeta('Destroy an actor in the active level.', actorDeleteMeta),
    { actor_id: z.string() },
    async (params) => {
      const r = await actorDeleteHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'actor_transform',
    appendMeta('Reposition, rotate, or scale an existing actor.', actorTransformMeta),
    {
      actor_id: z.string(),
      location: coerceVec3.optional(),
      rotation: coerceVec3.optional(),
      scale: coerceVec3.optional(),
    },
    async (params) => {
      const r = await actorTransformHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  // ── Scene domain ────────────────────────────────────────────────────────────

  server.tool(
    'scene_export',
    appendMeta('Export a 3D scene graph for LLM reasoning (flat / relational / hierarchical).', sceneExportMeta),
    {
      mode: z.enum(['flat', 'relational', 'hierarchical']).optional(),
      window: z.object({ min: vec3, max: vec3 }).optional(),
      max_items: z.coerce.number().int().optional(),
    },
    async (params) => {
      const r = await sceneExportHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'scene_validate_physics',
    appendMeta('Detect floating / interpenetrating actors in the level.', scenePhysicsMeta),
    {
      deep_check: coerceBool.optional(),
      window: z.object({ min: vec3, max: vec3 }).optional(),
    },
    async (params) => {
      const r = await sceneValidatePhysicsHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  // ── Editor domain ───────────────────────────────────────────────────────────

  server.tool(
    'editor_capture_viewport',
    appendMeta('Capture the active editor viewport as a base64 PNG.', captureMeta),
    {
      width: z.coerce.number().int().optional(),
      height: z.coerce.number().int().optional(),
    },
    async (params) => {
      const r = await editorCaptureViewportHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'editor_start_pie',
    appendMeta('Start Play-In-Editor.', pieMeta),
    { single_step: coerceBool.optional() },
    async (params) => {
      const r = await editorStartPieHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  server.tool(
    'editor_stream_log',
    appendMeta('Tail recent UE log lines (paged via since_line).', streamLogMeta),
    {
      filter: z.string().optional(),
      since_line: z.coerce.number().int().nonnegative().optional(),
    },
    async (params) => {
      const r = await editorStreamLogHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );

  // ── Perf telemetry (issue #5) ───────────────────────────────────────────────
  server.tool(
    'editor_get_perf_stats',
    appendMeta('Sample frame ms / draw calls / triangles / memory from FStatManager. Use this before suggesting scene optimizations.', perfStatsMeta),
    perfStatsSchema.shape,
    async (params) => {
      const r = await editorGetPerfStatsHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    },
  );

  server.tool(
    'texture_audit',
    appendMeta('Surface largest textures by memory + compression-format outliers, ordered descending. Use for technical-artist passes.', textureAuditMeta),
    textureAuditSchema.shape,
    async (params) => {
      const r = await textureAuditHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    },
  );

  server.tool(
    'mesh_audit',
    appendMeta('Surface highest-poly meshes, LOD-chain gaps, and instance-count hotspots. Pairs with texture_audit for full scene perf passes.', meshAuditMeta),
    meshAuditSchema.shape,
    async (params) => {
      const r = await meshAuditHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    },
  );

  // ── PCGEx tools ─────────────────────────────────────────────────────────────

  server.tool(
    'hayba_search_node_catalog',
    { query: z.string().describe('Search query — keyword, node class, or category') },
    async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_get_node_details',
    { class: z.string().describe('PCGEx node class name') },
    async (params) => {
      const result = await getNodeDetails({ class: params.class });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_create_pcg_graph',
    {
      graph: z.string().describe('JSON string of the PCGEx graph topology'),
      name: z.string().describe('Asset name for the new PCGGraph')
    },
    async ({ graph, name }) => {
      const result = await createPcgGraph({ graph, name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_pcg_graph',
    { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_list_pcg_assets',
    { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_export_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_execute_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to execute') },
    async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_check_ue_status',
    {},
    async () => {
      const result = await checkUeStatus();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_scrape_node_registry',
    {
      pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
      outputDbPath: z.string().optional().describe('Output SQLite DB path (default: Resources/pcgex_registry.db)'),
      forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
    },
    async (params) => {
      const result = await scrapeNodeRegistry(params as unknown as ScrapeNodeRegistryParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_match_pin_names',
    {
      fromClass: z.string().describe('Source node class'),
      fromPin: z.string().describe('Pin name on source node (may be approximate)'),
      toClass: z.string().describe('Target node class to find a matching input pin on'),
    },
    async (params) => {
      const result = await matchPinNames(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_attribute_flow',
    {
      graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
      strictMode: coerceBool.optional().describe('If true, also flag orphan writes (written but never consumed)'),
    },
    async (params) => {
      const result = await validateAttributeFlow(params as unknown as ValidateAttributeFlowParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_diff_against_working_asset',
    {
      wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
      referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
      diffMode: z.enum(['structural', 'properties', 'full']).optional().describe('What to diff (default: full)'),
    },
    async (params) => {
      const result = await diffAgainstWorkingAsset(params as unknown as DiffAgainstWorkingAssetParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_format_graph_topology',
    {
      graph: z.string().describe(
        'JSON string of the PCGEx graph to layout. ' +
        'Edges accept either canonical (fromNode/fromPin/toNode/toPin) or legacy (from/fromPin/to/toPin) keys. ' +
        'Output nodes carry a position:{x,y} object; the C++ legacy handler reads that.'
      ),
      algorithm: z.enum(['layered', 'grid']).optional().describe('Layout algorithm (default: layered)'),
      nodeWidth: z.number().int().optional().describe('Node width in pixels (default: 200)'),
      nodeHeight: z.number().int().optional().describe('Node height in pixels (default: 100)'),
      horizontalSpacing: z.number().int().optional().describe('Horizontal gap between layers (default: 150)'),
      verticalSpacing: z.number().int().optional().describe('Vertical gap between rows (default: 80)'),
      addCommentBlocks: z.boolean().optional().describe('Wrap category clusters in PCGComment nodes'),
    },
    async (params) => {
      const result = await formatGraphTopology(params as unknown as FormatGraphTopologyParams);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'hayba_abstract_to_subgraph',
    {
      graph: z.string().describe('JSON string of the full PCGEx graph'),
      nodeIds: z.array(z.string()).describe('Array of node IDs to extract into a subgraph'),
      subgraphName: z.string().optional().describe('Name for the extracted subgraph (default: SubGraph)'),
    },
    async (params) => {
      const result = await abstractToSubgraph(params as unknown as AbstractToSubgraphParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_parameterize_graph_inputs',
    {
      graph: z.string().describe('JSON string of the PCGEx graph'),
      targets: z.array(z.object({
        nodeId: z.string().describe('Node ID containing the hardcoded property'),
        property: z.string().describe('Property name to parameterize'),
        parameterName: z.string().optional().describe('Name for the graph parameter'),
      })).describe('List of properties to promote to graph parameters'),
    },
    async (params) => {
      const result = await parameterizeGraphInputs(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_query_pcgex_docs',
    {
      query: z.string().describe('Node class name or keyword to search documentation'),
      includeSourceSnippet: z.boolean().optional().default(false).describe('Include up to 80 lines from the header file'),
    },
    async (params) => {
      const result = await queryPcgexDocs(params as unknown as QueryPcgexDocsParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_initiate_infrastructure_brainstorm',
    'Plan complex graph architectures. IMPORTANT: After calling this tool, do NOT call hayba_create_pcg_graph, hayba_validate_pcg_graph, or any graph-mutation tool until the user explicitly approves an approach from the proposal.',
    {
      topic: z.string().describe('The infrastructure or system design topic to brainstorm'),
      context: z.string().optional().describe('Additional context about the project or constraints'),
      constraints: z.array(z.string()).optional().describe('Explicit constraints or requirements'),
    },
    async (params) => {
      const result = await initiateInfrastructureBrainstorm(params);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2) +
            '\n\n---\nIMPORTANT: This is a PROPOSAL ONLY. Do NOT call hayba_create_pcg_graph, ' +
            'hayba_validate_attribute_flow, hayba_abstract_to_subgraph, or any graph-mutation tool ' +
            'until the user has explicitly approved an approach above.',
        }]
      };
    }
  );

  // ── Worldbuilding hub — linguistics + planet physics packages ───────────────
  server.tool(
    'language_define_phonology',
    'Persist phoneme inventory (+ optional phonotactics) for deterministic validation / naming.',
    definePhonologySchema.shape,
    async (params) => {
      try {
        const result = definePhonology(params as z.infer<typeof definePhonologySchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'language_word_for',
    'Deterministic lexeme lookup for (language_id, concept_id); optionally seed the lexicon inline.',
    wordForSchema.shape,
    async (params) => {
      try {
        const result = languageWordFor(params as z.infer<typeof wordForSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'language_generate_name',
    'Seeded phonotactic name generation using phonology + phonotactics registered for the language.',
    generateNameSchema.shape,
    async (params) => {
      try {
        const result = languageGenerateName(params as z.infer<typeof generateNameSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'language_apply_sound_changes',
    'Placeholder for Lexurgy-style ordered rules (L5).',
    soundChangesSchema.shape,
    async (params) => {
      const result = languageApplySoundChanges(params as z.infer<typeof soundChangesSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'language_propose_derivation',
    'Placeholder for LLM-assisted constrained derivations (L7).',
    proposeDerivationSchema.shape,
    async (params) => {
      const result = languageProposeDerivation(params as z.infer<typeof proposeDerivationSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'language_remix_phonologies',
    'Placeholder for creole / substrate blending (L9).',
    remixPhonologiesSchema.shape,
    async (params) => {
      const result = languageRemixPhonologies(params as z.infer<typeof remixPhonologiesSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_planet_habitable_zone',
    'Kopparapu et al. (2014) HZ distances with Ramirez-style inner-edge mass correction.',
    hzSchema.shape,
    async (params) => {
      const result = planetHabitableZone(params as z.infer<typeof hzSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_planet_tidal_locking',
    'Darwin-style tidal locking timescale with constant Q.',
    tidalSchema.shape,
    async (params) => {
      const result = planetTidalLocking(params as z.infer<typeof tidalSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_planet_dynamo_field',
    'Christensen–Aubert-style dipole scaling diagnostic.',
    dynamoSchema.shape,
    async (params) => {
      const result = planetDynamoField(params as z.infer<typeof dynamoSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_planet_escape_regime',
    'Jeans parameter vs energy-limited escape heuristic.',
    escapeSchema.shape,
    async (params) => {
      const result = planetEscapeRegime(params as z.infer<typeof escapeSchema>);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_planet_stability_schema',
    'Returns stability-report JSON Schema + example fixture (planet-sim P8).',
    {},
    async () => {
      const result = planetStabilityReportPayload();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Gaea / terrain feature surface intentionally disabled — kept out of the
  // build by removing imports + registrations. Will return when the
  // worldbuilding-hub roadmap reaches the terrain integration phase.
  /*
  server.tool(
    'hayba_search_gaea_archetypes',
    {
      query: z.string().describe('Natural language terrain idea, e.g. "frozen coastal cliffs"'),
      biome_tags: z.array(z.string()).optional().describe('Filter to archetypes matching these biomes'),
      topology_filter: z.array(z.string()).optional().describe('Boost archetypes containing these Gaea node types'),
      limit: z.number().int().optional().default(3).describe('Max results (default: 3)'),
    },
    async (params) => {
      const result = await searchGaeaArchetypes(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_get_full_archetype_graph',
    {
      pattern_name: z.string().describe('Exact pattern_name from search_gaea_archetypes results'),
    },
    async (params) => {
      const result = await getFullArchetypeGraph(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_query_gaea_knowledge',
    {
      node_type: z.string().optional().describe('Gaea node type to look up (e.g. "Erosion2", "Mountain")'),
      phase: z.string().optional().describe('Filter by phase: base, character, simulation, lookdev, utility'),
      query: z.string().optional().describe('Search keyword for best practices and workflow patterns'),
    },
    async (params) => {
      const result = await queryGaeaKnowledge(params as QueryGaeaKnowledgeParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Gaea tools ───────────────────────────────────────────────────────────────

  server.tool(
    'hayba_brainstorm_gaea',
    'Brainstorm a Gaea terrain through RAG-powered knowledge search and multi-turn refinement. Returns archetype matches, best practices, common mistakes, and a synthesized graph plan. IMPORTANT: Always call this tool before hayba_create_terrain. Do NOT build a Gaea graph without first brainstorming through this tool.',
    {
      prompt: z.string().describe('Natural language terrain description, e.g. "alpine mountain with sharp ridges"'),
      step: z.enum(['start', 'followup', 'zones', 'finalize']).optional().default('start')
        .describe('Current step. start=initial RAG search, followup=refine with answer, zones=open painter, finalize=build graph plan'),
      answer: z.string().optional()
        .describe('User answer to a follow-up question from the previous step'),
      scratchSessionId: z.string().optional()
        .describe('Scratch session ID from the zones step, for reading painted zones'),
    },
    async (params) => {
      const result = await brainstormGaeaHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_bake_terrain',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses loaded terrain if omitted)'),
      variables: z.record(z.unknown()).optional().describe('Variable overrides to inject as -v key=value flags'),
      ignorecache: z.boolean().optional().describe('Force full re-bake ignoring cache (default: true)'),
    },
    async (params) => {
      const result = await bakeTerrain(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_create_terrain',
    'Create a Gaea terrain from a graph definition or template. IMPORTANT: Do NOT call this tool without first calling hayba_brainstorm_gaea. The brainstorm tool performs RAG search, knowledge lookup, and graph planning that is essential for quality terrain output.',
    {
      prompt: z.string().describe('Natural language terrain description — used for logging and as fallback if no graph provided'),
      name: z.string().optional().describe('Name for the terrain file (e.g. the landscape/project name). Used as the .terrain filename.'),
      template: z.string().optional().describe('Predefined terrain template: desert, mountains, tropical, volcanic'),
      template_overrides: z.record(z.unknown()).optional().describe('Override specific template parameters'),
      graph: z.unknown().optional().describe('Full Gaea node graph JSON with nodes and edges arrays. Use File nodes (params: { FileName: "<abs_path_to_mask.png>" }) to bring in painted zone masks as inputs.'),
      output_dir: z.string().optional().describe('Output directory (uses config default if omitted)'),
      resolution: z.number().optional().describe('Output heightmap resolution: 1024, 2048, or 4096 (default: 1024)'),
    },
    async (params) => {
      const result = await createTerrainHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_in_gaea',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await openInGaeaTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_read_terrain_variables',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await readTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_terrain_variables',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)'),
      contract: z.record(z.unknown()).describe('Variable contract: keys are variable names, values define type/default/min/max'),
      values: z.record(z.unknown()).optional().describe('Values to write; missing keys use contract defaults'),
    },
    async (params) => {
      const result = await setTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_session',
    { path: z.string().describe('Absolute path to the .terrain file to open') },
    async (params) => {
      const result = await openSessionHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_close_session',
    {},
    async () => {
      const result = await closeSessionHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_add_node',
    {
      type: z.string().describe('Node type, e.g. "Mountain", "Erosion2". Call hayba_list_node_types to see options.'),
      id: z.string().describe('Unique name for this node, e.g. "peaks", "erode"'),
      params: z.record(z.unknown()).optional().describe('Optional parameter overrides'),
      position: z.object({ X: z.number(), Y: z.number() }).optional(),
    },
    async (params) => {
      const result = await addNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_remove_node',
    { id: z.string().describe('Node id to remove') },
    async (params) => {
      const result = await removeNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_connect_nodes',
    {
      from_id: z.string().describe('Source node id'),
      from_port: z.string().describe('Source port, e.g. "Out"'),
      to_id: z.string().describe('Target node id'),
      to_port: z.string().describe('Target port, e.g. "In"'),
    },
    async (params) => {
      const result = await connectNodesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_graph_state',
    {},
    async () => {
      const result = await getGraphStateHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_parameters',
    { node_id: z.string().describe('Node id as shown in hayba_get_graph_state') },
    async (params) => {
      const result = await getParametersHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_parameter',
    {
      node_id: z.string(),
      parameter: z.string().describe('Parameter name as returned by hayba_get_parameters'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value within valid range'),
    },
    async (params) => {
      const result = await setParameterHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_list_node_types',
    { category: z.string().optional().describe('Filter by category, e.g. "erosion", "primitives"') },
    async (params) => {
      const result = await listNodeTypesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_cook_graph',
    { nodes: z.array(z.string()).optional().describe('Node ids for partial re-cook; omit for full cook') },
    async (params) => {
      const result = await cookGraphHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
  */ // end Gaea + Knowledge tool block

  // ── Conventions tools ────────────────────────────────────────────────────────

  server.tool(
    'hayba_setup_conventions',
    'Multi-turn wizard to configure UE project conventions. Call repeatedly with advancing stages.',
    {
      stage: z.enum(['start', 'folders', 'naming', 'workflow', 'confirm', 'save']).describe('Current wizard stage'),
      preset: z.enum(['epic-default', 'gamedevtv', 'custom']).optional().describe('Preset to load (required at start stage)'),
      answers: z.record(z.unknown()).optional().describe('Accumulated user responses from previous stages'),
      target: z.enum(['global', 'project']).optional().describe('Where to save (required at save stage)'),
      projectRoot: z.string().optional().describe('UE project root path (required if target is project)'),
    },
    async (params) => {
      const result = await setupConventionsHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_analyze_conventions',
    'Scan a UE project Content directory and infer conventions from existing folder structure and asset naming.',
    {
      projectRoot: z.string().describe('Path to UE project root (contains .uproject file)'),
      save: z.boolean().optional().describe('If true, write inferred conventions to target (default: false — dry run)'),
      target: z.enum(['global', 'project']).optional().describe('Where to save (required when save is true)'),
    },
    async (params) => {
      const result = await analyzeConventionsHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );

  // Landscape import surface intentionally disabled with the rest of the
  // terrain features. See note above.

  // ── Scene workflow ────────────────────────────────────────────────────────────

  /* Disabled: depends on Gaea pipeline; will be re-added later.
  server.tool(
    'hayba_ue_landscape_pipeline',
    'Full UE landscape project pipeline: guided brainstorm → zone painting → Gaea terrain generation → bake → import into Unreal Engine → foliage zones. Use this for major landscape projects that will be imported into UE5. For standalone Gaea terrain work, use hayba_brainstorm_gaea instead.',
    {
      step: z.enum(['start', 'biome', 'scale', 'features', 'name', 'layout', 'preview', 'bake', 'foliage', 'done'])
        .describe('Current step in the pipeline flow. Always start with "start".'),
      answer: z.string().optional()
        .describe('The user\'s answer to the previous step\'s question.'),
      projectId: z.string().optional()
        .describe('Project ID — returned by the "layout" step, pass it through on subsequent steps.'),
      projectName: z.string().optional()
        .describe('Name for the project, used at the "layout" step when creating the project.'),
      biomeAnswer: z.string().optional()
        .describe('The biome answer from step "biome" — used for archetype search in preview.'),
      featureAnswer: z.string().optional()
        .describe('The feature answer from step "features" — used for archetype search in preview.'),
    },
    async (params) => {
      const result = await ueLandscapePipelineHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
  */

  // ── Zone Painter tools ──────────────────────────────────────────────────────

  server.tool(
    'hayba_open_zone_painter',
    {
      projectId: z.string().optional().describe('Existing project ID. Omit to create a new project.'),
      projectName: z.string().optional().describe('Name for the new project (used when projectId is omitted).'),
      phase: z.enum(['a', 'b']).optional().describe('Phase A = blank canvas, Phase B = heightmap overlay (default: a).'),
    },
    async (params) => {
      const result = await openZonePainterHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_read_zones',
    {
      projectId: z.string().optional().describe('Project ID to read submitted zones from.'),
      scratchSessionId: z.string().optional().describe('Scratch session ID (for standalone zone painting without a project).'),
    },
    async (params) => {
      const result = await readZonesHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_painter_heightmap',
    {
      projectId: z.string().describe('Project ID to associate the heightmap with.'),
      heightmapPath: z.string().describe('Absolute path to the baked heightmap PNG or R16 file.'),
    },
    async (params) => {
      const result = await setPainterHeightmapHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );
}

// Schema registry seeding. Mirrors the Zod shapes used by the eager
// server.tool() calls above, but lives independently of the Code Mode gate
// so get_tool_signature can derive params from real schemas at runtime.
// New tools should add an entry here when first registered.
function recordEagerSchemas(
  reg: (name: string, shape: z.ZodRawShape, cost: Cost, returns: string) => void,
): void {
  const vec3 = z.tuple([z.number(), z.number(), z.number()]);
  const coerceBool = z.preprocess(
    (v) => typeof v === 'string' ? v.toLowerCase() === 'true' : v,
    z.boolean(),
  );
  const coerceVec3 = z.preprocess((v) => {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }, vec3);

  // ── Code Mode meta ────────────────────────────────────────────────────────
  reg('list_tool_categories', {}, 'low', '{categories:[{domain,commands:[string]}]}');
  reg('get_tool_signature',
    { command: z.string().describe('Exact command name, e.g. "actor_spawn"') },
    'low', '{command, params, returns, cost} or {status:"no_schema_available", did_you_mean}');
  reg('python_run', {
    script: z.string().describe('Python source to execute'),
    allow_unsafe: z.boolean().optional().describe('Override Tier 3 filesystem/subprocess block (DANGEROUS)'),
  }, 'high', '{ok, tier, stdout, stderr}');

  // ── Actor domain ──────────────────────────────────────────────────────────
  reg('actor_spawn', {
    class_path: z.string().describe('UE class path, e.g. "/Script/Engine.StaticMeshActor"'),
    location: coerceVec3.optional(),
    rotation: coerceVec3.optional(),
    scale: coerceVec3.optional(),
    label: z.string().optional(),
  }, 'medium', '{actor_id, label, class}');
  reg('actor_list', {
    class_filter: z.string().optional().describe('Exact class name filter'),
    tag: z.string().optional().describe('Tag filter'),
  }, 'low', '{actors:[{id,label,class,location}], count}');
  reg('actor_delete', { actor_id: z.string() }, 'low', '{ok, actor_id}');
  reg('actor_transform', {
    actor_id: z.string(),
    location: coerceVec3.optional(),
    rotation: coerceVec3.optional(),
    scale: coerceVec3.optional(),
  }, 'low', '{ok, actor_id, before, after}');

  // ── Scene domain ──────────────────────────────────────────────────────────
  reg('scene_export', {
    mode: z.enum(['flat', 'relational', 'hierarchical']).optional(),
    window: z.object({ min: vec3, max: vec3 }).optional(),
    max_items: z.coerce.number().int().optional(),
  }, 'medium', 'mode-specific shape');
  reg('scene_validate_physics', {
    deep_check: coerceBool.optional(),
    window: z.object({ min: vec3, max: vec3 }).optional(),
  }, 'medium', '{valid, floating, interpenetrating, checked_count, scanned_actors, skipped_system_actors}');

  // ── Editor domain ─────────────────────────────────────────────────────────
  reg('editor_capture_viewport', {
    width: z.coerce.number().int().optional(),
    height: z.coerce.number().int().optional(),
  }, 'medium', '{image_base64, width, height, camera}');
  reg('editor_start_pie', { single_step: coerceBool.optional() }, 'high', '{ok, pie_world_id}');
  reg('editor_stream_log', {
    filter: z.string().optional().describe('Plain substring filter (legacy)'),
    regex_filter: z.string().optional().describe('Perl-style regex applied to each line'),
    severity_filter: z.string().optional().describe('Comma-separated severities: Verbose,Display,Log,Warning,Error,Fatal'),
    format: z.enum(['raw', 'structured']).optional().describe('"structured" emits {line, category, severity, msg, raw} objects'),
    since_line: z.coerce.number().int().min(0).optional(),
  }, 'low', '{lines:[string|object], next_line:int, format}');

  // ── Perf telemetry (issue #5) ─────────────────────────────────────────────
  reg('editor_get_perf_stats', perfStatsSchema.shape, 'low', '{frame_ms, draw_calls, triangles, memory_mb, sampled_frames}');
  reg('texture_audit', textureAuditSchema.shape, 'medium', '{items:[{path, width, height, format, on_disk_kb, group, compression}], total_count}');
  reg('mesh_audit', meshAuditSchema.shape, 'medium', '{items:[{path, triangles, lod_count, instance_count, lod_issue?}], total_count}');

  // ── PCGEx domain ──────────────────────────────────────────────────────────
  reg('hayba_search_node_catalog', {
    query: z.string().describe('Search query — keyword, node class, or category'),
  }, 'low', '{results:[{class,category,description,inputs,outputs,key_properties}], matchType}');
  reg('hayba_get_node_details', {
    class: z.string().describe('PCGEx node class name'),
  }, 'low', '{class, category, description, inputs, outputs, properties}');
  reg('hayba_create_pcg_graph', {
    graph: z.string().describe('JSON string of the PCGEx graph topology'),
    name: z.string().describe('Asset name for the new PCGGraph'),
  }, 'high', '{ok, asset_path}');
  reg('hayba_validate_pcg_graph', {
    graph: z.string().describe('JSON string of the PCGEx graph to validate'),
  }, 'medium', '{valid, errors:[{type,node,pin,detail}], errorCount}');
  reg('hayba_list_pcg_assets', {
    path: z.string().optional().describe('Content path filter (default: /Game/)'),
  }, 'low', '{assets:[{name,path,nodeCount,edgeCount}], count}');
  reg('hayba_export_pcg_graph', {
    assetPath: z.string().describe('Full UE asset path to the PCGGraph'),
  }, 'medium', '{graph:{version,meta,nodes,edges,metadata}}');
  reg('hayba_execute_pcg_graph', {
    assetPath: z.string().describe('Full UE asset path to execute'),
  }, 'high', '{ok, generated_count, duration_ms}');
  reg('hayba_check_ue_status', {}, 'low', '{connected, status, ueVersion, plugin, pluginVersion}');

  // ── Asset domain — added Initiative #6 + #10 (ref-preserving move, deps) ─
  reg('asset_move', {
    path: z.string().describe('Source asset path, e.g. "/Game/Foo/Bar.Bar"'),
    target_dir: z.string().describe('Target content-browser folder, e.g. "/Game/Archive"'),
  }, 'medium', '{ok, old_path, new_path}');
  reg('asset_fix_redirectors', {
    path: z.string().optional().describe('Content path to scan (default /Game)'),
  }, 'medium', '{fixed_count, path}');
  reg('asset_get_dependencies', {
    path: z.string().describe('Asset path; returns what this asset depends on'),
  }, 'low', '{dependencies:[string], count}');
  reg('asset_get_referencers', {
    path: z.string().describe('Asset path; returns who depends on this asset (blast radius)'),
  }, 'low', '{referencers:[string], count}');
  reg('hayba_scrape_node_registry', {
    pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
    outputDbPath: z.string().optional().describe('Output SQLite DB path (default: Resources/pcgex_registry.db)'),
    forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
  }, 'high', '{nodes_scanned, pins_scanned, properties_scanned, db_path, catalog_path}');
  reg('hayba_match_pin_names', {
    fromClass: z.string().describe('Source node class'),
    fromPin: z.string().describe('Pin name on source node (may be approximate)'),
    toClass: z.string().describe('Target node class to find a matching input pin on'),
  }, 'low', '{matches:[{pin,confidence,reason}]}');
  reg('hayba_validate_attribute_flow', {
    graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
    strictMode: coerceBool.optional().describe('If true, also flag orphan writes (written but never consumed)'),
  }, 'medium', '{valid, errors:[{type,node,attribute,detail}]}');
  reg('hayba_diff_against_working_asset', {
    wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
    referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
    diffMode: z.enum(['structural', 'properties', 'full']).optional().describe('What to diff (default: full)'),
  }, 'medium', '{added, removed, modified, identical}');
  reg('hayba_format_graph_topology', {
    graph: z.string().describe('JSON string of the PCGEx graph to layout'),
    algorithm: z.enum(['layered', 'grid']).optional(),
    nodeWidth: z.number().int().optional(),
    nodeHeight: z.number().int().optional(),
    horizontalSpacing: z.number().int().optional(),
    verticalSpacing: z.number().int().optional(),
    addCommentBlocks: z.boolean().optional(),
  }, 'low', 'JSON string of laid-out graph (nodes carry position:{x,y})');
  reg('hayba_abstract_to_subgraph', {
    graph: z.string().describe('JSON string of the full PCGEx graph'),
    nodeIds: z.array(z.string()).describe('Array of node IDs to extract into a subgraph'),
    subgraphName: z.string().optional().describe('Name for the extracted subgraph (default: SubGraph)'),
  }, 'medium', '{subgraph, mainGraph}');
  reg('hayba_parameterize_graph_inputs', {
    graph: z.string().describe('JSON string of the PCGEx graph'),
    targets: z.array(z.object({
      nodeId: z.string(),
      property: z.string(),
      parameterName: z.string().optional(),
    })),
  }, 'medium', '{graph, parameters:[{name,type,defaultValue}]}');
  reg('hayba_query_pcgex_docs', {
    query: z.string().describe('Node class name or keyword to search documentation'),
    includeSourceSnippet: z.boolean().optional().describe('Include up to 80 lines from the header file'),
  }, 'low', '{results:[{class,description,sourceSnippet?}]}');
  reg('hayba_initiate_infrastructure_brainstorm', {
    topic: z.string().describe('The infrastructure or system design topic to brainstorm'),
    context: z.string().optional(),
    constraints: z.array(z.string()).optional(),
  }, 'low', '{approaches:[{name,description,nodes,tradeoffs}]} — PROPOSAL ONLY');

  // ── Conventions domain ────────────────────────────────────────────────────
  reg('hayba_setup_conventions', {
    stage: z.enum(['start', 'folders', 'naming', 'workflow', 'confirm', 'save']),
    preset: z.enum(['epic-default', 'gamedevtv', 'custom']).optional(),
    answers: z.record(z.unknown()).optional(),
    target: z.enum(['global', 'project']).optional(),
    projectRoot: z.string().optional(),
  }, 'low', '{stage, question?, next_stage?, saved_to?}');
  reg('hayba_analyze_conventions', {
    projectRoot: z.string().describe('Path to UE project root (contains .uproject file)'),
    save: z.boolean().optional(),
    target: z.enum(['global', 'project']).optional(),
  }, 'medium', '{inferred:{folders, naming, workflow}, saved_to?}');

  reg('language_define_phonology', definePhonologySchema.shape, 'low', '{ok, language_id, phoneme_count}');
  reg('language_word_for', wordForSchema.shape, 'low', '{lexeme}');
  reg('language_generate_name', generateNameSchema.shape, 'low', '{name}');
  reg('language_apply_sound_changes', soundChangesSchema.shape, 'low', '{ok, message}');
  reg('language_propose_derivation', proposeDerivationSchema.shape, 'low', '{ok, message}');
  reg('language_remix_phonologies', remixPhonologiesSchema.shape, 'low', '{ok, message}');
  reg('hayba_planet_habitable_zone', hzSchema.shape, 'low', 'HabitableZoneResult JSON');
  reg('hayba_planet_tidal_locking', tidalSchema.shape, 'low', 'TidalLockingResult JSON');
  reg('hayba_planet_dynamo_field', dynamoSchema.shape, 'low', 'DynamoScalingResult JSON');
  reg('hayba_planet_escape_regime', escapeSchema.shape, 'low', 'AtmosphericEscapeResult JSON');
  reg('hayba_planet_stability_schema', {}, 'low', '{schema_json, example}');

  // ── Landscape import ──────────────────────────────────────────────────────
  // hayba_import_landscape schema parked with the rest of the terrain stack.

  // ── Zone painter domain ───────────────────────────────────────────────────
  reg('hayba_open_zone_painter', {
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    phase: z.enum(['a', 'b']).optional(),
  }, 'low', '{ok, url, projectId}');
  reg('hayba_read_zones', {
    projectId: z.string().optional(),
    scratchSessionId: z.string().optional(),
  }, 'low', '{zones:[{id,label,mask_path,bounds}]}');
  reg('hayba_set_painter_heightmap', {
    projectId: z.string(),
    heightmapPath: z.string(),
  }, 'low', '{ok}');
}
