import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { appendMeta } from './hayba-tool-meta.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { recordSchema, type Cost } from './schema-registry.js';
import { installToolStreamMirror } from './tool-stream-mirror.js';
import { installLiveSender, executeCommand } from './tool-executor.js';
import { registerToolMeta } from './tool-meta-registry.js';
import { readSettings } from './routing/settings-watcher.js';
import { registerDeferredRouting, ALWAYS_ON_META, type CapturedTool, type RoutingHandle } from './routing/register.js';
import { registerTool, recordToolSchema, type ToolDescriptor } from './register-tool.js';
import { errorResult } from './tool-result.js';

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
import { handleWaitForShaders, meta as waitForShadersMeta } from './wait-for-shaders.js';
import { handleWaitForIdle, meta as waitForIdleMeta, schema as waitForIdleSchema } from './wait-for-idle.js';
import { handleRenderCamera, meta as renderCameraMeta, schema as renderCameraSchema } from './render-camera.js';
import { handleFabLoginStatus, meta as fabLoginStatusMeta } from './fab/login-status.js';
import { handleFabLibraryList, meta as fabLibraryListMeta } from './fab/library-list.js';
import { handleFabMarketplaceSearch, meta as fabMarketplaceSearchMeta } from './fab/marketplace-search.js';
import { handleFabDownload, meta as fabDownloadMeta } from './fab/download.js';

// ── Material instance-layer tool handlers ───────────────────────────────────
import { materialCreateHandler, meta as materialCreateMeta } from './material/material-create.js';
import { materialCreateInstanceHandler, meta as materialCreateInstanceMeta } from './material/material-create-instance.js';
import { materialSetParamHandler, meta as materialSetParamMeta } from './material/material-set-param.js';
import { materialApplyHandler, meta as materialApplyMeta } from './material/material-apply.js';
import { materialListHandler, meta as materialListMeta } from './material/material-list.js';
import { materialGetInfoHandler, meta as materialGetInfoMeta } from './material/material-get-info.js';

// ── Material graph-layer tool handlers ───────────────────────────────────────
import { materialAddNodeHandler, meta as materialAddNodeMeta } from './material/material-add-node.js';
import { materialSetNodeHandler, meta as materialSetNodeMeta } from './material/material-set-node.js';
import { materialDeleteNodeHandler, meta as materialDeleteNodeMeta } from './material/material-delete-node.js';
import { materialAddCommentHandler, meta as materialAddCommentMeta } from './material/material-add-comment.js';
import { materialDeleteCommentHandler, meta as materialDeleteCommentMeta } from './material/material-delete-comment.js';
import { materialSetCommentHandler, meta as materialSetCommentMeta } from './material/material-set-comment.js';
import { materialAddRerouteDeclarationHandler, meta as materialAddRerouteDeclarationMeta } from './material/material-add-reroute-declaration.js';
import { materialAddRerouteUsageHandler, meta as materialAddRerouteUsageMeta } from './material/material-add-reroute-usage.js';
import { assetDeleteHandler, meta as assetDeleteMeta } from './asset/asset-delete.js';
import { materialConnectNodesHandler, meta as materialConnectNodesMeta } from './material/material-connect-nodes.js';
import { materialFunctionCreateHandler, meta as materialFunctionCreateMeta } from './material/material-function-create.js';
import { materialSetMaterialPropertyHandler, meta as materialSetMaterialPropertyMeta } from './material/material-set-material-property.js';
import { materialCompileHandler, meta as materialCompileMeta } from './material/material-compile.js';
import { materialDisconnectHandler, meta as materialDisconnectMeta } from './material/material-disconnect.js';
import { materialValidateHandler, meta as materialValidateMeta } from './material/material-validate.js';
import { worldGenerateHandler, meta as worldGenerateMeta } from './world/world-generate.js';
import {
  textureGetInfoHandler, getInfoMeta as textureGetInfoMeta,
  textureSetCompressionHandler, setCompressionMeta as textureSetCompressionMeta,
  textureSetSettingsHandler, setSettingsMeta as textureSetSettingsMeta,
  textureListHandler, listMeta as textureListMeta,
} from './texture/texture-tools.js';

// ── Asset-source connectors (pure Node — no UE bridge except python_run) ──────
import { handlePolyhavenSearch, meta as polyhavenSearchMeta } from './asset-sources/polyhaven-search.js';
import { handlePolyhavenDownload, meta as polyhavenDownloadMeta } from './asset-sources/polyhaven-download.js';
import { handleAmbientCgSearch, meta as ambientcgSearchMeta } from './asset-sources/ambientcg-search.js';
import { handleAmbientCgDownload, meta as ambientcgDownloadMeta } from './asset-sources/ambientcg-download.js';
import { handleSketchfabSearch, meta as sketchfabSearchMeta } from './asset-sources/sketchfab-search.js';
import { handleSketchfabDownload, meta as sketchfabDownloadMeta } from './asset-sources/sketchfab-download.js';

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

// ── Agent-ergonomics tools (HANDOFF postmortem) ───────────────────────────────
import { introspectDescriptor } from './introspect/hayba-introspect.js';
import { pcgCookAndWaitHandler, schema as pcgCookSchema, meta as pcgCookMeta } from './pcg/pcg-cook-and-wait.js';
import {
  pcgAddNodeDescriptor, pcgSetPropDescriptor, pcgWireDescriptor, pcgInspectInstancesDescriptor,
} from './pcg/pcg-primitives.js';
import { toToolDescriptor } from './py-tool-factory.js';
import { generateLegacyDescriptors } from './legacy-tool-factory.js';


// ── Zone painter tool handlers ────────────────────────────────────────────────
import { openZonePainterHandler } from './hayba-open-zone-painter.js';
import { readZonesHandler } from './hayba-read-zones.js';
import { setPainterHeightmapHandler } from './hayba-set-painter-heightmap.js';

// ── Conventions tool handlers ─────────────────────────────────────────────────
import { setupConventionsHandler } from './hayba-setup-conventions.js';
import { analyzeConventionsHandler } from './hayba-analyze-conventions.js';

// ── Validator (runtime rule system + history panel feed) ────────────────────
import { appendNicheBriefing } from './niche-briefing.js';
import { installToolHooks } from '../validator/index.js';
import {
  validatorRunSchema, validatorRunHandler,
  validatorHistorySchema, validatorHistoryHandler,
  validatorResolveSchema, validatorResolveHandler,
  validatorClearSchema, validatorClearHandler,
  validatorRulesSchema, validatorRulesHandler,
  validatorSetRuleEnabledSchema, validatorSetRuleEnabledHandler,
  defaultScratchDir as validatorScratchDir,
} from './validator/tools.js';
import { ensureConnected as ensureUeForValidator } from '../tcp-client.js';

// ── PLUMB constraint subsystem (quantified validator + constraint language) ──
import {
  plumbPrimitivesSchema, plumbPrimitivesHandler,
  plumbProfileBakeSchema, plumbProfileBakeHandler,
  plumbProfileAnnotateSchema, plumbProfileAnnotateHandler,
  plumbProfileListSchema, plumbProfileListHandler,
  plumbProfileGetSchema, plumbProfileGetHandler,
  plumbConstraintDefineSchema, plumbConstraintDefineHandler,
  plumbConstraintListSchema, plumbConstraintListHandler,
  plumbConstraintRemoveSchema, plumbConstraintRemoveHandler,
  plumbConstraintProposeSchema, plumbConstraintProposeHandler,
  plumbValidateSchema, plumbValidateHandler,
  plumbMaskAddSchema, plumbMaskAddHandler,
  plumbMaskRemoveSchema, plumbMaskRemoveHandler,
  plumbLessonAddSchema, plumbLessonAddHandler,
  plumbLessonListSchema, plumbLessonListHandler,
  plumbLessonRemoveSchema, plumbLessonRemoveHandler,
  plumbStudySchema, plumbStudyHandler,
  plumbStudyTakeSchema, plumbStudyTakeHandler,
  plumbSegmentSchema, plumbSegmentHandler,
  plumbProductionDefineSchema, plumbProductionDefineHandler,
  plumbProductionListSchema, plumbProductionListHandler,
  plumbProductionRemoveSchema, plumbProductionRemoveHandler,
  plumbSocketAddSchema, plumbSocketAddHandler,
  plumbGrammarExpandSchema, plumbGrammarExpandHandler,
} from './plumb/tools.js';

// SessionManager (Gaea session) parked while terrain features are off — kept
// as a typed shim so registerTools' signature doesn't churn for callers.
// briefNicheOnce is used by the first-touch niche briefing system.
type SessionManagerStub = {
  briefNicheOnce?(domain: string): boolean;
  [key: string]: unknown;
};

// ── Shared Zod coercion helpers (module scope) ───────────────────────────────
// Hoisted so the single descriptor list (buildStandardDescriptors) is the only
// place each tool's shape is declared — consumed both by recordToolSchema
// (always) and registerTool (eager block). Previously these were defined twice:
// once in registerToolsCore and once in recordEagerSchemas, identically.
const dVec3 = z.tuple([z.number(), z.number(), z.number()]);
// Some MCP clients (incl. Claude Code's tool harness) JSON-stringify nested
// arrays/booleans before they hit Zod. Wrap so we accept both raw and the
// stringified form for params we know are commonly affected.
const dCoerceBool = z.preprocess(
  (v) => typeof v === 'string' ? v.toLowerCase() === 'true' : v,
  z.boolean(),
);
const dCoerceVec3 = z.preprocess((v) => {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}, dVec3);

/**
 * Single-source tool descriptor list.
 *
 * ## Pattern
 * Each entry is a ToolDescriptor that declares the tool ONCE. Two consumers
 * iterate this list:
 *   - recordEagerSchemas → recordToolSchema(d)   — records Zod shape + cost +
 *     returns into the schema registry so get_tool_signature can derive params
 *     at runtime, regardless of Code Mode.
 *   - registerToolsCore eager block → registerTool(server, session, d) — calls
 *     server.tool(appendMeta(desc, meta), schema, handler) + remember(name, meta),
 *     only when Code Mode is off.
 *
 * ## Eligible tools
 * A tool belongs here if:
 *   1. Its server.tool schema and its reg() entry are identical (no drift).
 *   2. The handler is a plain ToolHandler — no custom closures or side-effects
 *      baked into the eager registration block.
 *   3. The tool returns ToolResult (not RichToolResult with image blocks).
 *
 * ## Non-eligible (stay hand-written)
 *   - editor_capture_viewport: custom wait_for_shaders pre-step closure.
 *   - editor_stream_log: reg schema adds fields absent from server.tool schema.
 *   - pcg_cook_and_wait: 3-step TS orchestrator (python generate → wait_for_idle → python inspect), not a single buildScript.
 *   - PLUMB / validator / PCGEx / zone-painter / conventions: these have no
 *     meta or non-standard registration — migrate incrementally as needed.
 *
 * ## Adding a new tool
 * Add a ToolDescriptor entry here. Do NOT add a separate server.tool call in
 * registerToolsCore or a separate reg() call in recordEagerSchemas — those
 * are now generated automatically from this list.
 */
const M = 'material'; // niche domain for the material toolset
// Hand-written descriptors. Kept as a named const so the generated legacy list
// can be de-duplicated against these names before splicing (see below).
const HANDWRITTEN_STANDARD_DESCRIPTORS: ToolDescriptor[] = [
    // ── World generation (always-on flagship) ────────────────────────────────
    {
      name: 'world_generate',
      description: 'Build an environment from a natural-language biome description. Parses the prompt into layers (canopy/rock/undergrowth/groundcover), resolves one of the PROJECT\'S OWN StaticMeshes per layer, plans a deterministic seeded scatter across an area actor, then PLUMB-VALIDATES and auto-corrects every instance IN MEMORY (grounded, non-interpenetrating) before spawning — "scatter and prove", not scatter-and-hope. Use dry_run to get the validated plan without spawning.',
      meta: worldGenerateMeta,
      handler: worldGenerateHandler,
      cost: 'high',
      returns: '{ok, center_cm, layers:[{role,keywords,asset}], gaps:[string], planned, validation:{ran,passes,failed_before,failed_after,fixed}, ism_actors, instances, place_errors?, sample?}. Places one Instanced-Static-Mesh actor per resolved mesh with the validated transforms as instances.',
      schema: {
        area_actor: z.string().min(1).describe('Label of an actor whose location centres the biome region'),
        prompt: z.string().min(1).describe('Natural-language biome description'),
        radius_cm: z.number().positive().optional().describe('Scatter radius in cm (default 1500)'),
        count: z.number().int().positive().optional().describe('Total instances across all layers (default 40)'),
        seed: z.number().int().optional().describe('Deterministic seed (default 1337)'),
        ground_tolerance_m: z.number().positive().optional().describe('Grounded tolerance in metres (default 0.1)'),
        dry_run: z.boolean().optional().describe('Plan + validate only; do not spawn'),
      },
    },

    // ── Actor domain ────────────────────────────────────────────────────────
    {
      name: 'actor_spawn',
      description: 'Spawn a new actor in the active level.',
      meta: actorSpawnMeta,
      handler: actorSpawnHandler,
      cost: 'medium',
      returns: '{actor_id, label, class}',
      schema: {
        class_path: z.string().describe('UE class path, e.g. "/Script/Engine.StaticMeshActor"'),
        location: dCoerceVec3.optional(),
        rotation: dCoerceVec3.optional(),
        scale: dCoerceVec3.optional(),
        label: z.string().optional(),
      },
    },
    {
      name: 'actor_list',
      description: 'Enumerate actors in the active level.',
      meta: actorListMeta,
      handler: actorListHandler,
      cost: 'low',
      returns: '{actors:[{id,label,class,location}], count}',
      schema: {
        class_filter: z.string().optional().describe('Exact class name filter'),
        tag: z.string().optional().describe('Tag filter'),
      },
    },
    {
      name: 'actor_delete',
      description: 'Destroy an actor in the active level.',
      meta: actorDeleteMeta,
      handler: actorDeleteHandler,
      cost: 'low',
      returns: '{ok, actor_id}',
      schema: { actor_id: z.string() },
    },
    {
      name: 'actor_transform',
      description: 'Reposition, rotate, or scale an existing actor.',
      meta: actorTransformMeta,
      handler: actorTransformHandler,
      cost: 'low',
      returns: '{ok, actor_id, before, after}',
      schema: {
        actor_id: z.string(),
        location: dCoerceVec3.optional(),
        rotation: dCoerceVec3.optional(),
        scale: dCoerceVec3.optional(),
      },
    },

    // ── Material instance-layer domain ────────────────────────────────────────
    {
      name: 'material_create',
      description: 'Create a new material asset.',
      meta: materialCreateMeta,
      handler: materialCreateHandler,
      cost: 'low',
      returns: '{path, name}',
      niche: M,
      schema: {
        package_path: z.string().min(1).describe('UE content path for the new material'),
        name: z.string().min(1).describe('Name of the material asset'),
      },
    },
    {
      name: 'material_create_instance',
      description: 'Create a new material instance derived from a parent material.',
      meta: materialCreateInstanceMeta,
      handler: materialCreateInstanceHandler,
      cost: 'low',
      returns: '{path, name}',
      niche: M,
      schema: {
        parent_material_path: z.string().min(1).describe('Path to the parent material asset'),
        package_path: z.string().min(1).describe('UE content path for the new material instance'),
        name: z.string().min(1).describe('Name of the material instance asset'),
      },
    },
    {
      name: 'material_set_param',
      description: 'Set a scalar, vector (rgba), or texture parameter on a material instance.',
      meta: materialSetParamMeta,
      handler: materialSetParamHandler,
      cost: 'low',
      returns: '{ok}',
      niche: M,
      schema: {
        instance_path: z.string().min(1).describe('Path to the material instance'),
        param_name: z.string().min(1).describe('Name of the parameter to set'),
        value: z.union([
          z.number().describe('Scalar value'),
          z.array(z.number()).min(1).max(4).describe('Vector value (1-4 components for rgba)'),
          z.string().describe('Texture asset path'),
        ]).describe('Parameter value: scalar, vector (1-4 elements), or texture asset path'),
      },
    },
    {
      name: 'material_apply',
      description: 'Apply a material to an actor in the level (optionally specifying a material slot).',
      meta: materialApplyMeta,
      handler: materialApplyHandler,
      cost: 'medium',
      returns: '{ok, actor_id, material_path, slot}',
      niche: M,
      schema: {
        actor_id: z.string().min(1).describe('ID of the actor to apply the material to'),
        material_path: z.string().min(1).describe('Path to the material asset to apply'),
        slot_index: z.number().int().nonnegative().optional().describe('Material slot index (default 0)'),
      },
    },
    {
      name: 'material_list',
      description: 'List materials and material instances in the project or a specific path.',
      meta: materialListMeta,
      handler: materialListHandler,
      cost: 'low',
      returns: '{materials:[{path,type,is_instance}]}',
      niche: M,
      schema: {
        path: z.string().optional().describe('UE content path filter (default: list all)'),
      },
    },
    {
      name: 'material_get_info',
      description: 'Inspect a material, material function, or material instance: properties, parameters, and the full expression graph. For materials/functions, each expression input includes its source edge (from_node + from_output), each node reports output_consumed + reachable_from_output, and a top-level dead_nodes[] lists every node NOT reachable from any material output — i.e. provably dead, safe to delete (no delete-recompile-compare needed).',
      meta: materialGetInfoMeta,
      handler: materialGetInfoHandler,
      cost: 'low',
      returns: "{kind, name, expressions:[{id,class,x,y,output_consumed,reachable_from_output,reroute_name?,reroute_kind?,inputs:[{name,index,connected,from_node,from_output}],outputs:[{name,index}]}], dead_nodes:[{id,class}], comments} | instance:{kind,name,parent,parameters:[{name,type,value}]}. Named-reroute nodes report reroute_name + reroute_kind('declaration'|'usage') so you can bind a usage to a declaration WITHOUT scanning expressions in python. outputs[] gives a node's real output pin order (esp. MaterialFunctionCall, whose order follows FunctionOutput sort priority, NOT the visual layout) — wire from_output by these.",
      niche: M,
      schema: {
        path: z.string().min(1).describe('Path to the material or material instance to inspect'),
      },
    },

    // ── Material graph-layer domain ───────────────────────────────────────────
    {
      name: 'material_add_node',
      description: 'Add a new expression node to a material graph. For a MaterialFunctionCall, pass properties.function (asset path) — the node\'s inputs/outputs are rebuilt immediately (UpdateFromFunctionResource), so its output pins are wirable right away and are returned in outputs[]. No recompile/refresh dance needed.',
      meta: materialAddNodeMeta,
      handler: materialAddNodeHandler,
      cost: 'low',
      returns: '{node_id, outputs?:[{name,index}]}  — outputs[] present for MaterialFunctionCall nodes (the pin names to use as from_output)',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        expression_class: z.string().min(1).describe('UE expression class name, e.g. "MaterialExpressionVectorParameter"'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y] for the new node'),
        properties: z.record(z.string(), z.unknown()).optional().describe('Initial properties for the node. For a MaterialFunctionCall set "function" (or "function_path") to the function asset path — outputs are rebuilt immediately and returned.'),
      },
    },
    {
      name: 'material_set_node',
      description: 'Move and/or set properties on an existing node in a material graph.',
      meta: materialSetNodeMeta,
      handler: materialSetNodeHandler,
      cost: 'low',
      returns: '{node_id}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        node_id: z.string().min(1).describe('ID/name of the existing node to update'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('New graph position [x, y]'),
        properties: z.record(z.string(), z.unknown()).optional().describe('Properties to set on the node'),
      },
    },
    {
      name: 'material_delete_node',
      description: 'Delete an existing node from a material graph.',
      meta: materialDeleteNodeMeta,
      handler: materialDeleteNodeHandler,
      cost: 'low',
      returns: '{deleted}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        node_id: z.string().min(1).describe('ID/name of the node to delete'),
      },
    },
    {
      name: 'material_set_property',
      description: 'Set master-material settings (blend mode, domain, shading model, two-sided, opacity mask clip).',
      meta: materialSetMaterialPropertyMeta,
      handler: materialSetMaterialPropertyHandler,
      cost: 'low',
      returns: '{applied:[keys]}',
      niche: M,
      schema: {
        material_path: z.string().min(1).describe('Path to the master material asset'),
        properties: z.record(z.string(), z.unknown()).describe('Settings; aliases: domain, blend_mode, shading_model, two_sided, opacity_mask_clip_value, enable_tessellation'),
      },
    },
    {
      name: 'material_compile',
      description: 'Finalize a material OR material FUNCTION: write it to disk, apply staged settings, surface translator errors + shader optimization stats (materials). Graph edits DEFER the disk write — call this once the graph is complete. NOTE: material functions no longer auto-save either, so after editing a function call material_compile with function_path to persist it (this avoids a half-built function crashing the editor when it is opened/compiled).',
      meta: materialCompileMeta,
      handler: materialCompileHandler,
      cost: 'medium',
      returns: '{errors:[string], has_errors, saved, stats:{shaders:[{name,instructions}], texture_samples, ...}} (materials) | {saved} (functions)',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the master material asset to compile (either this or function_path)'),
        function_path: z.string().optional().describe('Path to a material FUNCTION to finalize + save (either this or material_path)'),
      },
    },
    {
      name: 'material_validate',
      description: 'Statically check a material OR material FUNCTION graph for translator-crash-prone wiring WITHOUT compiling: reroutes/named-reroutes used downstream that resolve to no input, and connections to non-existent output indices — both trigger an uncatchable HLSL-translator assert that kills the editor. material_compile runs these same checks and refuses to compile when any fail, so call this first to fix issues safely.',
      meta: materialValidateMeta,
      handler: materialValidateHandler,
      cost: 'low',
      returns: '{ok:boolean, problems:[string]}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the master material to validate (either this or function_path)'),
        function_path: z.string().optional().describe('Path to a material FUNCTION to validate (either this or material_path)'),
      },
    },
    {
      name: 'texture_get_info',
      description: 'Inspect a Texture2D: dimensions, source/platform format, mip count, compression settings, LOD group, sRGB, never-stream, address modes.',
      meta: textureGetInfoMeta,
      handler: textureGetInfoHandler,
      cost: 'low',
      returns: '{path, width, height, format, num_mips, compression_settings, lod_group, srgb, never_stream, address_x, address_y}',
      schema: {
        path: z.string().min(1).describe('Texture asset path, e.g. /Game/Tex/T_Rock'),
      },
    },
    {
      name: 'texture_set_compression',
      description: 'Set a texture\'s compression (TC_*) and optionally LOD group + sRGB. Re-imports the texture resource. For other properties (mip gen, max size, filter, address, ...) use texture_set_settings.',
      meta: textureSetCompressionMeta,
      handler: textureSetCompressionHandler,
      cost: 'low',
      returns: '{ok, path, compression_settings, lod_group, srgb}',
      schema: {
        path: z.string().min(1).describe('Texture asset path'),
        compression_settings: z.string().min(1).describe('TextureCompressionSettings, e.g. Normalmap / Masks / Default (TC_ prefix optional)'),
        lod_group: z.string().optional().describe('TextureGroup, e.g. World / WorldNormalMap (TEXTUREGROUP_ prefix optional)'),
        srgb: z.boolean().optional().describe('sRGB flag'),
      },
    },
    {
      name: 'texture_set_settings',
      description: 'Set any texture properties at once via reflection. Aliases: compression_settings, lod_group, srgb, never_stream, address_x, address_y, mip_gen_settings, max_texture_size, flip_green_channel, filter, virtual_texture_streaming, lod_bias. Any raw UTexture UPROPERTY name also works. Re-imports the resource after applying.',
      meta: textureSetSettingsMeta,
      handler: textureSetSettingsHandler,
      cost: 'low',
      returns: '{ok, path, applied:[string], compression_settings, lod_group, srgb, never_stream}',
      schema: {
        path: z.string().min(1).describe('Texture asset path'),
        properties: z.record(z.string(), z.unknown()).describe('Settings to set, e.g. { compression_settings: "Normalmap", srgb: false, mip_gen_settings: "Sharpen4" }'),
      },
    },
    {
      name: 'texture_list',
      description: 'List Texture2D assets, optionally filtered by path prefix.',
      meta: textureListMeta,
      handler: textureListHandler,
      cost: 'low',
      returns: '{textures:[{path, width, height, compression_settings}], count}',
      schema: {
        path_prefix: z.string().optional().describe('Only list textures whose path starts with this, e.g. /Game/Tex'),
      },
    },
    {
      name: 'material_add_comment',
      description: 'Add a titled comment box around a group of nodes in a material or function graph.',
      meta: materialAddCommentMeta,
      handler: materialAddCommentHandler,
      cost: 'low',
      returns: '{comment_id}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        text: z.string().describe('Comment title/text shown on the box'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('Top-left graph position [x, y]'),
        size: z.tuple([z.number(), z.number()]).optional().describe('Box size [width, height]'),
        color: z.array(z.number()).min(3).max(4).optional().describe('Box color [r, g, b] or [r, g, b, a] (0..1)'),
        font_size: z.number().int().optional().describe('Title font size (default 18)'),
      },
    },
    {
      name: 'material_delete_comment',
      description: 'Delete a comment box from a material or function graph (comment_id from material_get_info.comments[].id). Named reroutes are nodes — use material_delete_node for those.',
      meta: materialDeleteCommentMeta,
      handler: materialDeleteCommentHandler,
      cost: 'low',
      returns: '{deleted}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        comment_id: z.string().min(1).describe('Comment id to delete (from material_get_info.comments[].id)'),
      },
    },
    {
      name: 'material_set_comment',
      description: 'Edit an existing comment box (move/resize/retitle/recolor) by id — only the fields you pass change. Completes comment CRUD so comments never need a Python fallback.',
      meta: materialSetCommentMeta,
      handler: materialSetCommentHandler,
      cost: 'low',
      returns: '{comment_id}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        comment_id: z.string().min(1).describe('Comment id to edit (from material_get_info.comments[].id)'),
        text: z.string().optional().describe('New title/text'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('New top-left graph position [x, y]'),
        size: z.tuple([z.number(), z.number()]).optional().describe('New box size [width, height]'),
        color: z.array(z.number()).min(3).max(4).optional().describe('New color [r, g, b] or [r, g, b, a] (0..1)'),
        font_size: z.number().int().optional().describe('New title font size'),
      },
    },
    {
      name: 'material_add_reroute_declaration',
      description: 'Create a named-reroute declaration (source anchor) so a value can be referenced by name instead of long wires.',
      meta: materialAddRerouteDeclarationMeta,
      handler: materialAddRerouteDeclarationHandler,
      cost: 'low',
      returns: '{node_id}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        name: z.string().min(1).describe('The reroute name (what usages bind to)'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y]'),
        color: z.array(z.number()).min(3).max(4).optional().describe('Node color [r, g, b] or [r, g, b, a] (0..1)'),
      },
    },
    {
      name: 'material_add_reroute_usage',
      description: 'Create a named-reroute usage bound to a declaration by name (replaces a long wire).',
      meta: materialAddRerouteUsageMeta,
      handler: materialAddRerouteUsageHandler,
      cost: 'low',
      returns: '{node_id}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        declaration_id: z.string().min(1).describe('node_id of the reroute declaration to bind to'),
        node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y]'),
      },
    },
    {
      name: 'asset_delete',
      description: 'Permanently delete a content asset by object path.',
      meta: assetDeleteMeta,
      handler: assetDeleteHandler,
      cost: 'low',
      returns: '{deleted}',
      schema: {
        path: z.string().min(1).describe('Object path of the asset to delete, e.g. /Game/Foo/MF_X.MF_X'),
      },
    },
    {
      name: 'material_connect_nodes',
      description: "Connect two nodes in a material graph or connect a node output to a material property. IMPORTANT for multi-output sources (esp. MaterialFunctionCall): you MUST pick the output pin with from_output (the pin NAME) or from_output_index — otherwise the call is rejected, because defaulting to the first output silently swaps function outputs (e.g. Albedo<->F0). Get the real pin names/order from material_get_info.expressions[].outputs[]. May return clutter-prevention suggestions: use named reroutes when a source fans out to 2+ targets, or a reroute knee node when a wire would run backward/over another node.",
      meta: materialConnectNodesMeta,
      handler: materialConnectNodesHandler,
      cost: 'low',
      returns: '{connected, from_node_fanout?, suggestions?[]}',
      niche: M,
      schema: {
        material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
        function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
        from_node: z.string().min(1).describe('ID or name of the source node'),
        from_output: z.string().optional().describe('Output pin NAME on the source node (from material_get_info.expressions[].outputs[].name). REQUIRED when the source has >1 output (e.g. a material function) unless you pass from_output_index.'),
        to_node: z.string().optional().describe('ID or name of the target node'),
        to_input: z.string().optional().describe('Input pin name on the target node'),
        to_input_index: z.number().int().optional().describe('Target input pin by index (unnamed pins, e.g. Substrate slab inputs)'),
        from_output_index: z.number().int().optional().describe('Source output pin by index (default 0)'),
        to_property: z.string().optional().describe('Target material output, e.g. base_color, normal, front_material (Substrate), displacement (Nanite tessellation - needs material_set_property enable_tessellation=true)'),
      },
    },
    {
      name: 'material_function_create',
      description: 'Create a new material function asset in the project.',
      meta: materialFunctionCreateMeta,
      handler: materialFunctionCreateHandler,
      cost: 'low',
      returns: '{path, name}',
      niche: M,
      schema: {
        package_path: z.string().min(1).describe('UE content path for the new material function'),
        name: z.string().min(1).describe('Name of the material function asset'),
      },
    },
    {
      name: 'material_disconnect',
      description: 'Break a connection in a material graph — clear a node input or a material output property.',
      meta: materialDisconnectMeta,
      handler: materialDisconnectHandler,
      cost: 'low',
      returns: '{disconnected}',
      niche: M,
      schema: {
        material_path: z.string().min(1).describe('Path to the material asset'),
        to_node: z.string().optional().describe('ID or name of the target node whose input should be disconnected'),
        to_input: z.string().optional().describe('Input pin name on the target node (defaults to first input)'),
        to_input_index: z.number().int().nonnegative().optional().describe('Zero-based input pin index (alternative to to_input)'),
        to_property: z.string().optional().describe('Material output property name to disconnect (e.g. base_color, normal)'),
      },
    },

    // ── Scene domain ──────────────────────────────────────────────────────────
    {
      name: 'scene_export',
      description: 'Export a 3D scene graph for LLM reasoning (flat / relational / hierarchical).',
      meta: sceneExportMeta,
      handler: sceneExportHandler,
      cost: 'medium',
      returns: 'mode-specific shape',
      schema: {
        mode: z.enum(['flat', 'relational', 'hierarchical']).optional(),
        window: z.object({ min: dVec3, max: dVec3 }).optional(),
        max_items: z.coerce.number().int().optional(),
      },
    },
    {
      name: 'scene_validate_physics',
      description: 'Detect floating / interpenetrating actors in the level.',
      meta: scenePhysicsMeta,
      handler: sceneValidatePhysicsHandler,
      cost: 'medium',
      returns: '{valid, floating, interpenetrating, checked_count, scanned_actors, skipped_system_actors}',
      schema: {
        deep_check: dCoerceBool.optional(),
        window: z.object({ min: dVec3, max: dVec3 }).optional(),
      },
    },

    // ── Editor domain ─────────────────────────────────────────────────────────
    // editor_capture_viewport and editor_stream_log are hand-written below:
    //   - editor_capture_viewport: custom wait_for_shaders pre-step closure +
    //     server.tool-vs-reg schema divergence (wait_for_shaders field in
    //     eager schema, omitted from reg). Cannot cleanly fit the descriptor.
    //   - editor_stream_log: reg adds regex_filter/severity_filter/format that
    //     are NOT in the eager server.tool shape — schema divergence, left as-is.
    {
      name: 'editor_start_pie',
      description: 'Start Play-In-Editor.',
      meta: pieMeta,
      handler: editorStartPieHandler,
      cost: 'high',
      returns: '{ok, pie_world_id}',
      schema: {
        single_step: dCoerceBool.optional(),
      },
    },

    // ── Wait / capture helpers ──────────────────────────────────────────────
    // These tools were eagerly registered but absent from recordEagerSchemas,
    // meaning get_tool_signature had no schema to return for them. Migration
    // adds them to the single-source list so the schema is recorded once.
    {
      name: 'wait_for_shaders',
      description: 'Wait for UE shader compilation to settle (or timeout). Thin wrapper around wait_for_idle({subsystems:["shaders"]}).',
      meta: waitForShadersMeta,
      handler: async (args, _session) => handleWaitForShaders(args as any) as never,
      cost: 'high',
      returns: '{settled:bool, waited_ms:int} or legacy {status, subsystems}',
      schema: {
        max_seconds: z.number().int().min(1).max(600).optional().describe('Upper bound in seconds (default 60).'),
        poll_seconds: z.number().min(0.05).max(10).optional().describe('Poll interval in seconds (default 1). NOTE: ignored — UE-side polling is fixed at 250ms.'),
      },
    },
    {
      name: 'wait_for_idle',
      description: 'Wait for UE subsystems (shaders/assets/gc/pcg/world_tick) to settle before reading back or rendering. Default = shaders+assets+gc+pcg.',
      meta: waitForIdleMeta,
      handler: async (args, _session) => handleWaitForIdle(args as never) as never,
      cost: 'high',
      returns: '{settled, subsystems:{shaders,assets,gc,pcg,world_tick}}',
      schema: waitForIdleSchema.shape,
    },
    {
      name: 'render_camera',
      description: 'Render a camera view to disk and VERIFY the file landed (magic bytes + dimensions). Accepts either an actor reference or an inline transform. Calls wait_for_idle internally before capture.',
      meta: renderCameraMeta,
      handler: async (args, _session) => handleRenderCamera(args as never) as never,
      cost: 'high',
      returns: '{ok, path, width, height, format, bytes}',
      schema: renderCameraSchema.shape,
    },

    // ── Fab connector domain ────────────────────────────────────────────────
    {
      name: 'hayba_fab_login_status',
      description: 'Check whether the user is currently logged into Fab through the UE editor.',
      meta: fabLoginStatusMeta,
      handler: async (args, _session) => handleFabLoginStatus(args as any),
      cost: 'low',
      returns: '{logged_in:bool, user?:string}',
      schema: {},
    },
    {
      name: 'hayba_fab_library_list',
      description: "List a page of the user's Fab library (assets they own).",
      meta: fabLibraryListMeta,
      handler: async (args, _session) => handleFabLibraryList(args as any),
      cost: 'medium',
      returns: '{assets:[{id,title,type}], next_cursor?}',
      schema: {
        count: z.number().int().min(1).max(100).optional().describe('Number of results per page (default 20).'),
        page: z.string().optional().describe('Pagination cursor from previous call.'),
      },
    },
    {
      name: 'hayba_fab_marketplace_search',
      description: 'Search the public Fab marketplace for assets matching a query.',
      meta: fabMarketplaceSearchMeta,
      handler: async (args, _session) => handleFabMarketplaceSearch(args as any),
      cost: 'medium',
      returns: '{assets:[{id,title,type,price}], next_cursor?}',
      schema: {
        query: z.string().min(1).describe('Search query string.'),
        type: z.string().optional().describe('Filter by asset type (e.g. "Material", "StaticMesh").'),
        page: z.string().optional().describe('Pagination cursor from previous call.'),
      },
    },
    {
      name: 'hayba_fab_download',
      description: 'Download a Fab asset into the active UE project.',
      meta: fabDownloadMeta,
      handler: async (args, _session) => handleFabDownload(args as any),
      cost: 'high',
      returns: '{ok, import_path}',
      schema: {
        asset_id: z.string().min(1).describe('Fab asset identifier.'),
        download_url: z.string().url().describe('Signed download URL from library_list / search result item.'),
        target_dir: z.string().optional().describe('Project content path, e.g. /Game/Fab/MyAsset. Defaults to /Game/Fab/<asset_id>.'),
        wait: z.boolean().optional().describe('If true, blocks until download completes (up to 10min cap on the C++ side). Default true.'),
      },
    },

    // ── Asset-source connectors (Poly Haven / ambientCG / Sketchfab) ────────
    {
      name: 'hayba_polyhaven_search',
      description: 'Search Poly Haven for CC0 HDRIs, textures, or models.',
      meta: polyhavenSearchMeta,
      handler: async (args, _session) => handlePolyhavenSearch(args as any),
      cost: 'medium',
      returns: '{assets:[{id,name,type,categories,download_count}]}',
      schema: {
        query: z.string().min(1).describe('Search query string.'),
        type: z.enum(['hdris', 'textures', 'models']).optional().describe('Asset type filter (default "textures").'),
        categories: z.string().optional().describe('Comma-separated Poly Haven category filter.'),
      },
    },
    {
      name: 'hayba_polyhaven_download',
      description: 'Download a Poly Haven asset (HDRI / texture maps / glTF model) and import into UE.',
      meta: polyhavenDownloadMeta,
      handler: async (args, _session) => handlePolyhavenDownload(args as any),
      cost: 'high',
      returns: '{ok, imported_paths:[string], target_dir}',
      schema: {
        asset_id: z.string().min(1).describe('Poly Haven asset slug.'),
        type: z.enum(['hdris', 'textures', 'models']).optional().describe('Asset type (default "textures").'),
        resolution: z.enum(['1k', '2k', '4k', '8k']).optional().describe('Resolution tier (default "2k").'),
        target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/polyhaven/<asset_id>.'),
      },
    },
    {
      name: 'hayba_ambientcg_search',
      description: 'Search ambientCG for CC0 PBR materials, decals, or 3D models.',
      meta: ambientcgSearchMeta,
      handler: async (args, _session) => handleAmbientCgSearch(args as any),
      cost: 'medium',
      returns: '{assets:[{id,name,downloadCount,tags}]}',
      schema: {
        query: z.string().min(1).describe('Search query string.'),
        type: z.string().optional().describe('ambientCG asset type (default "Material").'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
      },
    },
    {
      name: 'hayba_ambientcg_download',
      description: 'Download an ambientCG material zip and import into UE.',
      meta: ambientcgDownloadMeta,
      handler: async (args, _session) => handleAmbientCgDownload(args as any),
      cost: 'high',
      returns: '{ok, imported_paths:[string], target_dir}',
      schema: {
        asset_id: z.string().min(1).describe('ambientCG asset id (e.g. "Bricks075A").'),
        resolution: z.string().optional().describe('Attribute string (e.g. "1K-JPG", "2K-JPG", "4K-PNG"). Default "2K-JPG".'),
        target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/ambientcg/<asset_id>.'),
      },
    },
    {
      name: 'hayba_sketchfab_search',
      description: 'Search Sketchfab for downloadable 3D models. Requires SKETCHFAB_API_TOKEN env var.',
      meta: sketchfabSearchMeta,
      handler: async (args, _session) => handleSketchfabSearch(args as any),
      cost: 'medium',
      returns: '{models:[{uid,name,license,downloadCount}]}',
      schema: {
        query: z.string().min(1).describe('Search query string.'),
        downloadable: z.boolean().optional().describe('Filter to downloadable-only models (default true).'),
        count: z.number().int().min(1).max(48).optional().describe('Max results (default 24).'),
      },
    },
    {
      name: 'hayba_sketchfab_download',
      description: 'Download a Sketchfab model and import into UE. Requires SKETCHFAB_API_TOKEN env var.',
      meta: sketchfabDownloadMeta,
      handler: async (args, _session) => handleSketchfabDownload(args as any),
      cost: 'high',
      returns: '{ok, imported_path, uid}',
      schema: {
        uid: z.string().min(1).describe('Sketchfab model uid.'),
        flavour: z.enum(['gltf', 'usdz', 'source']).optional().describe('Download flavour (default "gltf").'),
        target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/sketchfab/<uid>.'),
      },
    },

    // ── Agent-ergonomics tools (HANDOFF postmortem) — factory path ────────────
    // These 5 python-backed tools are expressed as PyToolDescriptors and adapted
    // here via toToolDescriptor so they flow through the same always-record /
    // eager-register loops as every other STANDARD_DESCRIPTORS entry.
    // pcg_cook_and_wait is a 3-step TS orchestrator and stays hand-written below.
    toToolDescriptor(introspectDescriptor),
    toToolDescriptor(pcgAddNodeDescriptor),
    toToolDescriptor(pcgSetPropDescriptor),
    toToolDescriptor(pcgWireDescriptor),
    toToolDescriptor(pcgInspectInstancesDescriptor),
];

// Single-source tool descriptor list = hand-written entries + the sidecar-
// generated legacy tools. The generator surfaces every sidecar command that is
// agent_callable:true && has_ts_wrapper:false (~55) as a first-class tool,
// skipping any name that collides with a hand-written descriptor. Both the
// recordEagerSchemas loop and the eager registerTool loop consume this merged
// list identically — so generated tools are recorded + registered exactly once,
// with real get_tool_signature schemas. Exported so tests can verify schema
// presence and the no-drift / no-duplicate invariants.
export const STANDARD_DESCRIPTORS: ToolDescriptor[] = [
  ...HANDWRITTEN_STANDARD_DESCRIPTORS,
  ...generateLegacyDescriptors(
    new Set(HANDWRITTEN_STANDARD_DESCRIPTORS.map((d) => d.name)),
  ),
];

export async function registerTools(server: McpServer, session: SessionManagerStub): Promise<RoutingHandle | null> {
  const settings = readSettings();
  if (settings.toolRouting === 'deferred') {
    // γ-hybrid: capture every server.tool(...) call into a descriptor map
    // without registering it. registerDeferredRouting wires the always-on
    // meta-tools and packs against the captured set.
    const captured = new Map<string, CapturedTool>();
    const realTool = server.tool.bind(server);

    type ToolArgs = [string, ...unknown[]];
    (server as unknown as { tool: (...a: ToolArgs) => void }).tool = (name, ...rest) => {
      let description: string | undefined;
      let schema: z.ZodRawShape;
      let handler: (...args: unknown[]) => unknown;
      if (typeof rest[0] === 'string') {
        description = rest[0] as string;
        schema = rest[1] as z.ZodRawShape;
        handler = rest[2] as (...args: unknown[]) => unknown;
      } else {
        schema = rest[0] as z.ZodRawShape;
        handler = rest[1] as (...args: unknown[]) => unknown;
      }
      const dir = inferDir(name);
      captured.set(name, { description, schema, handler, dir });
      // Don't forward to realTool — registerDeferredRouting re-registers only
      // the always-on subset + alwaysLoadPacks tools.
    };

    // Force the eager registration block to run so we capture every tool,
    // not just the codeMode always-on five. Restore on exit.
    const origCodeMode = config.codeMode;
    (config as { codeMode: boolean }).codeMode = false;
    try {
      registerToolsCore(server, session);
    } finally {
      (config as { codeMode: boolean }).codeMode = origCodeMode;
      (server as unknown as { tool: typeof realTool }).tool = realTool;
    }

    // Note: ALWAYS_ON_META is imported but used implicitly via
    // registerDeferredRouting's always-on registrations.
    void ALWAYS_ON_META;

    // Re-install the tool-stream mirror on the (now restored) real server.tool
    // so newly-registered meta-tools and pack-loaded tools get mirrored. The
    // capturing shim above suppressed the mirror's wrapper during capture.
    installToolStreamMirror(server);

    // Now register meta-tools + alwaysLoadPacks. Awaited so the caller can
    // sequence server.connect() after every server.tool() call has happened
    // — McpServer rejects late registrations with "Cannot register
    // capabilities after connecting to transport".
    const handle = await registerDeferredRouting(server, captured);
    return handle;
  }

  registerToolsCore(server, session);
  return null;
}

/**
 * Infer the pack-source directory for a tool name by matching against the
 * known top-level dirs under src/tools/. Root-level tools return null.
 */
function inferDir(name: string): string | null {
  if (name.startsWith('actor_'))          return 'actor';
  if (name.startsWith('scene_'))          return 'scene';
  if (name.startsWith('editor_'))         return 'editor';
  if (name.startsWith('material_'))       return 'material';
  if (name.startsWith('hayba_fab_'))      return 'fab';
  if (name.startsWith('hayba_polyhaven_'))return 'asset-sources';
  if (name.startsWith('hayba_ambientcg_'))return 'asset-sources';
  if (name.startsWith('hayba_sketchfab_'))return 'asset-sources';
  if (name === 'python_run')              return 'python';
  if (name === 'list_tool_categories' || name === 'get_tool_signature') return 'code-mode';
  return null;
}

/** Attach a first-touch niche briefing to a ToolResult when appropriate. */
function withNicheBriefing(
  domain: string,
  session: SessionManagerStub,
  r: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return appendNicheBriefing(domain, session, { content: r.content, isError: r.isError });
}

function registerToolsCore(server: McpServer, session: SessionManagerStub): void {

  // Fire-and-forget: dynamic import resolves in <1ms; MCP handshake takes longer
  // so any tool call is guaranteed to find DEFAULT_SENDER set.
  void installLiveSender();

  // Local helper: pushes the tool's meta into the registry so the ToolExecutor
  // can look up cost by command name. Keeps registration sites one-liner.
  const remember = (name: string, meta: HaybaToolMeta | undefined): void => {
    if (meta) registerToolMeta(name, meta);
  };

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
        const data = await executeCommand('hayba_propose_plan', params as Record<string, unknown>, { timeout: 5000 });
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error pushing plan to UE: ${(e as Error).message}`);
      }
    },
  );
  // no meta registered (plan control tool)

  server.tool(
    'hayba_mark_plan_step',
    'Update the status of a single step in the proposed plan shown in the UE Plan panel. Marking a step "completed" auto-advances the next step to "running". Call this as you work through an approved plan so the user sees live progress.',
    {
      index: z.number().int().min(0)
        .describe('Zero-based index of the plan step to update'),
      status: z.enum(['running', 'completed', 'failed']).default('completed')
        .describe('New status for the step (default "completed")'),
    },
    async (params) => {
      try {
        const data = await executeCommand('plan_mark_step', params as Record<string, unknown>, { timeout: 5000 });
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error marking plan step in UE: ${(e as Error).message}`);
      }
    },
  );
  // no meta registered (plan control tool)

  server.tool(
    'list_tool_categories',
    appendMeta('List all HaybaOS command domains and their commands. Call this first to discover what is available before requesting a specific schema.', listMeta),
    {},
    async () => {
      const r = await listToolCategoriesHandler({}, session);
      return { content: r.content, isError: r.isError };
    }
  );
  remember('list_tool_categories', listMeta);

  server.tool(
    'get_tool_signature',
    appendMeta('Return the JSON schema (params, return shape, cost) for a specific HaybaOS command. Call list_tool_categories first to find command names.', sigMeta),
    { command: z.string().describe('Exact command name, e.g. "actor_spawn"') },
    async (params) => {
      const r = await getToolSignatureHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );
  remember('get_tool_signature', sigMeta);

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
  remember('python_run', pyMeta);

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

  // Some MCP clients (incl. Claude Code's tool harness) JSON-stringify nested
  // booleans before they hit Zod. Wrap so we accept both raw and the
  // stringified form for params we know are commonly affected. (vec3/coerceVec3
  // now live at module scope as dVec3/dCoerceVec3, used by the descriptor list.)
  const coerceBool = z.preprocess(
    (v) => typeof v === 'string' ? v.toLowerCase() === 'true' : v,
    z.boolean()
  );

  // ── Standard tools (actor / material / scene) ───────────────────────────────
  // Registered from the single descriptor list. Each descriptor declares the
  // tool once; registerTool does server.tool(appendMeta(...)) + remember(...),
  // and recordEagerSchemas already recorded the schema (always, above).
  for (const d of STANDARD_DESCRIPTORS) registerTool(server, session, d);

  // ── Editor domain ───────────────────────────────────────────────────────────

  server.tool(
    'editor_capture_viewport',
    appendMeta('Capture the active editor viewport and return it as an inline image block (plus a small text block with camera/width/height). Set HAYBA_CAPTURE_TO_FILE to also spill the image to a temp file path.', captureMeta),
    {
      width: z.coerce.number().int().optional(),
      height: z.coerce.number().int().optional(),
      wait_for_shaders: z.boolean().optional().describe('If true, calls wait_for_shaders first (max_seconds=60, poll_seconds=1).'),
    },
    async (params) => {
      if ((params as any).wait_for_shaders === true) {
        await handleWaitForShaders({ max_seconds: 60, poll_seconds: 1 });
      }
      const r = await editorCaptureViewportHandler(params as Record<string, unknown>, session);
      return { content: r.content, isError: r.isError };
    }
  );
  remember('editor_capture_viewport', captureMeta);

  // editor_start_pie is now in STANDARD_DESCRIPTORS — registered via the loop above.

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
  remember('editor_stream_log', streamLogMeta);

  // wait_for_shaders, wait_for_idle, render_camera are now in STANDARD_DESCRIPTORS.

  // ── Agent-ergonomics tools (HANDOFF postmortem) ─────────────────────────────
  // hayba_introspect, pcg_add_node, pcg_set_prop, pcg_wire, pcg_inspect_instances
  // are now in STANDARD_DESCRIPTORS (registered via the descriptor loop above).

  server.tool(
    'pcg_cook_and_wait',
    appendMeta('Regenerate an actor\'s PCGComponent, block on the PCG graph settling (NOT world_tick), and return per-mesh ISM instance counts — all in one call.', pcgCookMeta),
    pcgCookSchema.shape,
    async (params) => {
      const r = await pcgCookAndWaitHandler(params as never);
      return { content: r.content, isError: r.isError };
    }
  );
  remember('pcg_cook_and_wait', pcgCookMeta);

  // hayba_fab_*, hayba_polyhaven_*, hayba_ambientcg_*, hayba_sketchfab_* tools
  // are now in STANDARD_DESCRIPTORS — registered via the loop above.

  // ── PCGEx tools ─────────────────────────────────────────────────────────────

  server.tool(
    'hayba_search_node_catalog',
    { query: z.string().describe('Search query — keyword, node class, or category') },
    async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_get_node_details',
    { class: z.string().describe('PCGEx node class name') },
    async (params) => {
      const result = await getNodeDetails({ class: params.class });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_validate_pcg_graph',
    { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_list_pcg_assets',
    { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_export_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_execute_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to execute') },
    async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

  server.tool(
    'hayba_check_ue_status',
    {},
    async () => {
      const result = await checkUeStatus();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (PCGEx pure-TS handler)

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
  // no meta registered (conventions pure-TS handler)

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
  // no meta registered (conventions pure-TS handler)

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
  // no meta registered (zone painter pure-TS handler)

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
  // no meta registered (zone painter pure-TS handler)

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
  // no meta registered (zone painter pure-TS handler)

  // ──────────────────────────────────────────────────────────────────────────
  // ── Validator (runtime rule system + history) ───────────────────────────
  //
  // Five MCP tools that expose the validator surface to agents and to the
  // UE plugin's Validator panel:
  //   - validator_run      : manual evaluation pass
  //   - validator_history  : read persisted findings
  //   - validator_resolve  : mark a finding resolved / unresolved
  //   - validator_clear    : wipe history
  //   - validator_rules    : list the rule catalog (+ disabled state)
  //
  // Rule definitions live in src/validator/rules.ts; evaluators in
  // src/validator/tool-hooks.ts (auto-installed below).
  // ──────────────────────────────────────────────────────────────────────────
  // Install evaluator hooks once — wires actual logic onto rules catalog.
  installToolHooks();

  const getUe = async () => {
    try { return await ensureUeForValidator().catch(() => null); } catch { return null; }
  };

  server.tool(
    'validator_run',
    'Manually evaluate validator rules. Pass scope=\'all\' or { rule_ids: [...] }. Persists findings to history.',
    validatorRunSchema,
    async (args: { scope?: 'all' | { rule_ids?: string[] }; persist?: boolean }) => {
      const ue = await getUe();
      const r = await validatorRunHandler(args, { ue, scratchDir: validatorScratchDir() });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'validator_history',
    'Read persisted validator findings. Filter by limit / since_iso / include_resolved / rule_ids.',
    validatorHistorySchema,
    async (args: { limit?: number; since_iso?: string; include_resolved?: boolean; rule_ids?: string[] }) => {
      const r = await validatorHistoryHandler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'validator_resolve',
    'Mark a validator finding as resolved (or restore it). Identifies the finding by its ISO timestamp.',
    validatorResolveSchema,
    async (args: { timestamp: string; resolved: boolean }) => {
      const r = await validatorResolveHandler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'validator_clear',
    'Clear the validator history. Requires { confirm: true } to actually wipe.',
    validatorClearSchema,
    async (args: { confirm: boolean }) => {
      const r = await validatorClearHandler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'validator_rules',
    'Return the validator rule catalog. Include each rule\'s message, hint, refs, and disabled state.',
    validatorRulesSchema,
    async (args: { include_disabled_state?: boolean }) => {
      const r = await validatorRulesHandler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'validator_set_rule_enabled',
    'Enable or disable a validator rule by id. Persists to .scratch/validator-config.json.',
    validatorSetRuleEnabledSchema,
    async (args: { rule_id: string; enabled: boolean }) => {
      const r = await validatorSetRuleEnabledHandler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  // ── PLUMB constraint subsystem ──────────────────────────────────────────
  //
  // Quantified, directional validator + a tiny CLOSED constraint language bound
  // to assets/tags, plus baked physical profiles. Authoring fills values; the
  // grammar (10 primitives) never grows. See src/plumb/.
  const j = (r: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] });

  server.tool('plumb_primitives',
    'List the COMPLETE closed constraint grammar — the 10 primitives, their gate, hard/soft default, params, and docs. Author constraints by picking one and filling params.',
    plumbPrimitivesSchema, async () => j(await plumbPrimitivesHandler()));

  // Auto-fetch StaticMesh bounds (cm) via the UE mesh_get_info command when the
  // caller omits origin_cm/extent_cm — "point at an SM and bake".
  const fetchMeshBounds = async (asset: string) => {
    const data = await executeCommand('mesh_get_info', { path: asset }) as { bounds?: { min: Record<string, number>; max: Record<string, number>; extents: Record<string, number> } };
    const b = data?.bounds;
    if (!b) throw new Error('mesh_get_info returned no bounds');
    const v = (o: Record<string, number>): [number, number, number] => [o.x ?? 0, o.y ?? 0, o.z ?? 0];
    return { min: v(b.min), max: v(b.max), extents: v(b.extents) };
  };
  server.tool('plumb_profile_bake',
    'Bake the deterministic geometry/physics half of a Physical Asset Profile. Pass just the asset to auto-fetch bounds from UE (mesh_get_info), or supply origin_cm + extent_cm (+ optional pivot_to_base_cm) explicitly. Persists to the profile store.',
    plumbProfileBakeSchema, async (a) => j(await plumbProfileBakeHandler(a, new Date().toISOString(), fetchMeshBounds)));

  server.tool('plumb_profile_annotate',
    'Layer AI/human qualitative semantics (class, up/front vectors, named affordance regions) onto a baked profile, with optional field locks. Qualitative constraints can only hard-gate on locked fields.',
    plumbProfileAnnotateSchema, async (a) => j(await plumbProfileAnnotateHandler(a)));

  server.tool('plumb_profile_list',
    'List baked profiles (asset_id, archetype, affordance count, locked fields). Feeds the Memory tab.',
    plumbProfileListSchema, async () => j(await plumbProfileListHandler()));

  server.tool('plumb_profile_get',
    'Fetch one full Physical Asset Profile by asset path.',
    plumbProfileGetSchema, async (a) => j(await plumbProfileGetHandler(a)));

  server.tool('plumb_constraint_define',
    'Author/upsert a bound constraint: a primitive id + params + a binding (exactly one of {asset, tag}). Validated against the closed primitive set — invalid primitives/params/bindings are rejected.',
    plumbConstraintDefineSchema, async (a) => j(await plumbConstraintDefineHandler(a)));

  server.tool('plumb_constraint_list',
    'List the constraint library (optionally filtered to an asset binding).',
    plumbConstraintListSchema, async (a) => j(await plumbConstraintListHandler(a)));

  server.tool('plumb_constraint_remove',
    'Remove a constraint from the library by id.',
    plumbConstraintRemoveSchema, async (a) => j(await plumbConstraintRemoveHandler(a)));

  server.tool('plumb_constraint_propose',
    'Draft (does not save) constraints for an asset from its baked profile, using only closed primitives. Review/edit then call plumb_constraint_define.',
    plumbConstraintProposeSchema, async (a) => j(await plumbConstraintProposeHandler(a)));

  server.tool('plumb_validate',
    'Run library constraints over a set of instances and return a PLUMB Verdict (gated, directional: per-gate ok + signed value_m + FixVector; hard fails set stopped_at, soft fails accumulate soft_cost).',
    plumbValidateSchema, async (a) => j(await plumbValidateHandler(a)));

  server.tool('plumb_mask_add',
    'Add or update a mask (surface = triangle set; volume = translucent shape) on a baked profile. Surface/volume masks are the regions constraints reference.',
    plumbMaskAddSchema, async (a) => j(await plumbMaskAddHandler(a)));
  server.tool('plumb_mask_remove',
    'Remove a mask from a profile by id.',
    plumbMaskRemoveSchema, async (a) => j(await plumbMaskRemoveHandler(a)));

  server.tool('plumb_lesson_add',
    'Add/update a lesson — the durable [[slug]] knowledge that explains WHY a constraint exists (browsed in the Studio Lessons panel; cited by constraint/validator refs).',
    plumbLessonAddSchema, async (a) => j(await plumbLessonAddHandler(a, new Date().toISOString())));
  server.tool('plumb_lesson_list',
    'List lessons (slug + title + refs).',
    plumbLessonListSchema, async () => j(await plumbLessonListHandler()));
  server.tool('plumb_lesson_remove',
    'Remove a lesson by slug.',
    plumbLessonRemoveSchema, async (a) => j(await plumbLessonRemoveHandler(a)));

  server.tool('plumb_study',
    'AI study entry point: returns the asset\'s baked profile (if any) + the closed primitive grammar + mask kinds + guidance, so the agent can propose masks (plumb_mask_add) and constraints (plumb_constraint_define).',
    plumbStudySchema, async (a) => j(await plumbStudyHandler(a)));

  server.tool('plumb_study_take',
    'Drain pending "Study with AI" requests from the Semantic Studio button. Returns the assets to study (then call plumb_study + author masks/constraints for each).',
    plumbStudyTakeSchema, async () => j(await plumbStudyTakeHandler()));

  server.tool('plumb_segment',
    'AI-segment a studied asset: given the study_render color passes, the agent\'s themed part labels + a box/points per view, runs SAM in the visual sidecar and back-projects to geometry-hugging surface masks (triangles via the world-position pass + a UV display texture), written into the profile. Replaces hand-placed blocky masks.',
    plumbSegmentSchema, async (a) => j(await plumbSegmentHandler(a)));

  server.tool('plumb_production_define',
    'Author/upsert a grammar production rule: an LHS symbol kind (+ optional attribute guards) → an RHS sequence of emit ops (shell/asset/symbol/scatter/decal/fill). Guards are constraint ids that must pass before the production fires.',
    plumbProductionDefineSchema, async (a) => j(await plumbProductionDefineHandler(a)));

  server.tool('plumb_production_list',
    'List all grammar productions in the store.',
    plumbProductionListSchema, async () => j(await plumbProductionListHandler()));

  server.tool('plumb_production_remove',
    'Remove a grammar production by id.',
    plumbProductionRemoveSchema, async (a) => j(await plumbProductionRemoveHandler(a)));

  server.tool('plumb_socket_add',
    'Add or replace a socket (connection point) on a baked profile. Idempotent on socket id.',
    plumbSocketAddSchema, async (a) => j(await plumbSocketAddHandler(a)));

  server.tool('plumb_grammar_expand',
    'Expand a seed symbol using the stored production rules + the PLUMB constraint store as guards. Returns a PlacementPlan. In dry-run (no UE scene), geometry-dependent constraints self-skip — rejections only reflect TS-evaluable constraints.',
    plumbGrammarExpandSchema, async (a) => j(await plumbGrammarExpandHandler(a)));

  // ── Landscape import (TS wrapper for UE-side landscape_import handler) ────
  server.tool(
    'hayba_import_landscape',
    'Import a heightmap (PNG or R16) as an UE Landscape actor. Wraps the UE-side landscape_import handler. The heightmap is sampled 0..uint16-max -> 0..maxHeightM (m). Spawns one Landscape covering worldSizeKm x worldSizeKm.',
    {
      heightmapPath: z.string().describe('Absolute path to a PNG or R16 heightmap file'),
      worldSizeKm: z.number().optional().default(8.0).describe('Landscape XY size in km'),
      maxHeightM: z.number().optional().default(600.0).describe('Maximum height in m (0..maxHeightM mapped from uint16)'),
      actorLabel: z.string().optional().default('Hayba_Terrain').describe('Label for the spawned Landscape actor'),
      landscapeMaterial: z.string().optional().describe('UE material path; empty = no material'),
    },
    async (params) => {
      try {
        const data = await executeCommand('landscape_import', params as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error importing landscape: ${(e as Error).message}`);
      }
    }
  );
  // no meta registered (thin UE bridge wrapper)
}

// Schema registry seeding. Mirrors the Zod shapes used by the eager
// server.tool() calls above, but lives independently of the Code Mode gate
// so get_tool_signature can derive params from real schemas at runtime.
// New tools should add an entry here when first registered.
function recordEagerSchemas(
  reg: (name: string, shape: z.ZodRawShape, cost: Cost, returns: string) => void,
): void {
  // coerceBool still used by hayba_validate_attribute_flow below. vec3/coerceVec3
  // moved to module scope (dVec3/dCoerceVec3) and consumed via STANDARD_DESCRIPTORS.
  const coerceBool = z.preprocess(
    (v) => typeof v === 'string' ? v.toLowerCase() === 'true' : v,
    z.boolean(),
  );

  // ── Standard tools (actor / material / scene) ──────────────────────────────
  // Schema recording from the single descriptor list. recordToolSchema mirrors
  // the old reg(name, shape, cost, returns) calls exactly, one per descriptor.
  for (const d of STANDARD_DESCRIPTORS) recordToolSchema(d);

  // ── Code Mode meta ────────────────────────────────────────────────────────
  reg('list_tool_categories', {}, 'low', '{categories:[{domain,commands:[string]}]}');
  reg('get_tool_signature',
    { command: z.string().describe('Exact command name, e.g. "actor_spawn"') },
    'low', '{command, params, returns, cost} or {status:"no_schema_available", did_you_mean}');
  reg('python_run', {
    script: z.string().describe('Python source to execute'),
    allow_unsafe: z.boolean().optional().describe('Override Tier 3 filesystem/subprocess block (DANGEROUS)'),
  }, 'high', '{ok, tier, stdout, stderr}');

  // ── Editor domain ─────────────────────────────────────────────────────────
  reg('editor_capture_viewport', {
    width: z.coerce.number().int().optional(),
    height: z.coerce.number().int().optional(),
  }, 'medium', '{image_base64, width, height, camera}');
  // editor_start_pie is now in STANDARD_DESCRIPTORS — recordToolSchema(d) called above.
  reg('editor_stream_log', {
    filter: z.string().optional().describe('Plain substring filter (legacy)'),
    regex_filter: z.string().optional().describe('Perl-style regex applied to each line'),
    severity_filter: z.string().optional().describe('Comma-separated severities: Verbose,Display,Log,Warning,Error,Fatal'),
    format: z.enum(['raw', 'structured']).optional().describe('"structured" emits {line, category, severity, msg, raw} objects'),
    since_line: z.coerce.number().int().min(0).optional(),
  }, 'low', '{lines:[string|object], next_line:int, format}');

  // ── Agent-ergonomics tools (HANDOFF postmortem) ───────────────────────────
  // hayba_introspect, pcg_add_node, pcg_set_prop, pcg_wire, pcg_inspect_instances:
  // now in STANDARD_DESCRIPTORS — recordToolSchema(d) called by the loop above.
  reg('pcg_cook_and_wait', pcgCookSchema.shape, 'high',
    '{ok, cook:{components}, idle, result:{ism:[{mesh,count}], total}}');

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


  // ── Landscape import ──────────────────────────────────────────────────────
  reg('hayba_import_landscape', {
    heightmapPath: z.string().describe('Absolute path to a PNG or R16 heightmap file'),
    worldSizeKm: z.number().optional().default(8.0).describe('Landscape XY size in km'),
    maxHeightM: z.number().optional().default(600.0).describe('Maximum height in m (0..maxHeightM mapped from uint16)'),
    actorLabel: z.string().optional().default('Hayba_Terrain').describe('Label for the spawned Landscape actor'),
    landscapeMaterial: z.string().optional().describe('UE material path; empty = no material'),
  }, 'high', '{actorLabel, heightmapPath, worldSizeKm, maxHeightM}');

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

  // ── PLUMB constraint subsystem ────────────────────────────────────────────
  reg('plumb_primitives', plumbPrimitivesSchema, 'low', '{primitives:[{id,gate,default_hard,qualitative,params,doc}]}');
  reg('plumb_profile_bake', plumbProfileBakeSchema, 'low', '{ok, profile}');
  reg('plumb_profile_annotate', plumbProfileAnnotateSchema, 'low', '{ok, profile|error}');
  reg('plumb_profile_list', plumbProfileListSchema, 'low', '{profiles:[{asset_id,profile,affordances,locked}]}');
  reg('plumb_profile_get', plumbProfileGetSchema, 'low', '{ok, profile|error}');
  reg('plumb_constraint_define', plumbConstraintDefineSchema, 'low', '{ok, errors?}');
  reg('plumb_constraint_list', plumbConstraintListSchema, 'low', '{constraints:[Constraint]}');
  reg('plumb_constraint_remove', plumbConstraintRemoveSchema, 'low', '{ok, removed}');
  reg('plumb_constraint_propose', plumbConstraintProposeSchema, 'low', '{ok, proposals:[Partial<Constraint>]|error}');
  reg('plumb_validate', plumbValidateSchema, 'low', '{verdict:Verdict}');
  reg('plumb_mask_add', plumbMaskAddSchema, 'low', '{ok, profile|error}');
  reg('plumb_mask_remove', plumbMaskRemoveSchema, 'low', '{ok, removed}');
  reg('plumb_lesson_add', plumbLessonAddSchema, 'low', '{ok, errors?}');
  reg('plumb_lesson_list', plumbLessonListSchema, 'low', '{lessons:[{slug,title,refs}]}');
  reg('plumb_lesson_remove', plumbLessonRemoveSchema, 'low', '{ok, removed}');
  reg('plumb_study', plumbStudySchema, 'low', '{asset, has_profile, profile?, primitives, mask_kinds, guidance}');
  reg('plumb_study_take', plumbStudyTakeSchema, 'low', '{requests:[{asset,ts}], note}');
  reg('plumb_segment', plumbSegmentSchema, 'high', '{ok, added:[label], skipped?, error?}');
  reg('plumb_production_define', plumbProductionDefineSchema, 'low', '{ok, errors?}');
  reg('plumb_production_list', plumbProductionListSchema, 'low', '{productions:[Production]}');
  reg('plumb_production_remove', plumbProductionRemoveSchema, 'low', '{ok, removed}');
  reg('plumb_socket_add', plumbSocketAddSchema, 'low', '{ok, profile|error}');
  reg('plumb_grammar_expand', plumbGrammarExpandSchema, 'low', '{plan:PlacementPlan, note}');
}
