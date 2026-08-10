import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { appendMeta } from './hayba-tool-meta.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { installToolStreamMirror, wrapToolHandlerForStream } from './tool-stream-mirror.js';
import { installLiveSender, executeCommand } from './tool-executor.js';
import { registerToolMeta } from './tool-meta-registry.js';
import { readSettings } from './routing/settings-watcher.js';
import { registerDeferredRouting, type CapturedTool, type RoutingHandle, type DeferredRoutingOptions } from './routing/register.js';
import {
  defineTool,
  materializeTool,
  registerTool,
  recordToolSchema,
  type ToolDescriptor,
} from './register-tool.js';
import { resolveAliases } from './param-aliases.js';
import { TOOL_ALIASES } from './tool-aliases.js';
import { AUDIO_DESCRIPTORS } from './audio/audio-tools.js';
import { errorResult, okResult } from './tool-result.js';

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

// ── Agent memory tool handlers (issue #355) ──────────────────────────────────
import { memoryWriteHandler, meta as memoryWriteMeta } from './memory/write.js';
import { memoryRecallHandler, meta as memoryRecallMeta } from './memory/recall.js';
import { memoryListHandler, meta as memoryListMeta } from './memory/list.js';
import { memoryDeleteHandler, meta as memoryDeleteMeta } from './memory/delete.js';
import { memoryExportHandler, meta as memoryExportMeta } from './memory/export-blocks.js';
import { memoryImportHandler, meta as memoryImportMeta } from './memory/import-blocks.js';
import { memoryPruneHandler, meta as memoryPruneMeta } from './memory/prune.js';

// ── Material instance-layer tool handlers ───────────────────────────────────
import { materialCreateHandler, meta as materialCreateMeta } from './material/material-create.js';
import {
  materialCreateInstanceHandler,
  meta as materialCreateInstanceMeta,
} from './material/material-create-instance.js';
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
import {
  materialAddRerouteDeclarationHandler,
  meta as materialAddRerouteDeclarationMeta,
} from './material/material-add-reroute-declaration.js';
import {
  materialAddRerouteUsageHandler,
  meta as materialAddRerouteUsageMeta,
} from './material/material-add-reroute-usage.js';
import { assetDeleteHandler, meta as assetDeleteMeta } from './asset/asset-delete.js';
import { materialConnectNodesHandler, meta as materialConnectNodesMeta } from './material/material-connect-nodes.js';
import {
  materialFunctionCreateHandler,
  meta as materialFunctionCreateMeta,
} from './material/material-function-create.js';
import {
  materialSetMaterialPropertyHandler,
  meta as materialSetMaterialPropertyMeta,
} from './material/material-set-material-property.js';
import { materialCompileHandler, meta as materialCompileMeta } from './material/material-compile.js';
import { materialDisconnectHandler, meta as materialDisconnectMeta } from './material/material-disconnect.js';
import { materialValidateHandler, meta as materialValidateMeta } from './material/material-validate.js';
import { uiCreateWidgetHandler, meta as uiCreateWidgetMeta } from './ui/ui-create-widget.js';
import { uiAddElementHandler, meta as uiAddElementMeta } from './ui/ui-add-element.js';
import { uiQueryHandler, meta as uiQueryMeta, schema as uiQuerySchema } from './ui/ui-query.js';
import {
  meta as uiSetWidgetPropertiesMeta,
  schema as uiSetWidgetPropertiesSchema,
  uiSetWidgetPropertiesHandler,
} from './ui/ui-set-widget-properties.js';
import {
  meta as uiSetPropertyMeta,
  schema as uiSetPropertySchema,
  uiSetPropertyHandler,
} from './ui/ui-set-property.js';
import {
  meta as uiSetTextStyleMeta,
  schema as uiSetTextStyleSchema,
  uiSetTextStyleHandler,
} from './ui/ui-set-text-style.js';
import { meta as uiSetBrushMeta, schema as uiSetBrushSchema, uiSetBrushHandler } from './ui/ui-set-brush.js';
import {
  meta as uiSetVisibilityMeta,
  schema as uiSetVisibilitySchema,
  uiSetVisibilityHandler,
} from './ui/ui-set-visibility.js';
import {
  meta as uiSetSlotLayoutMeta,
  schema as uiSetSlotLayoutSchema,
  uiSetSlotLayoutHandler,
} from './ui/ui-set-slot-layout.js';
import {
  meta as uiCompileWidgetMeta,
  schema as uiCompileWidgetSchema,
  uiCompileWidgetHandler,
} from './ui/ui-compile-widget.js';
import { meta as uiSaveWidgetMeta, schema as uiSaveWidgetSchema, uiSaveWidgetHandler } from './ui/ui-save-widget.js';
import {
  meta as uiGetWidgetInfoMeta,
  schema as uiGetWidgetInfoSchema,
  uiGetWidgetInfoHandler,
} from './ui/ui-get-widget-info.js';
import {
  meta as uiSearchWidgetsMeta,
  schema as uiSearchWidgetsSchema,
  uiSearchWidgetsHandler,
} from './ui/ui-search-widgets.js';
import {
  meta as uiListWidgetTypesMeta,
  schema as uiListWidgetTypesSchema,
  uiListWidgetTypesHandler,
} from './ui/ui-list-widget-types.js';
import { meta as docsSearchMeta, schema as docsSearchSchema, docsSearchHandler } from './docs/docs-search.js';
import {
  meta as docsLookupClassMeta,
  schema as docsLookupClassSchema,
  docsLookupClassHandler,
} from './docs/docs-lookup-class.js';
import {
  meta as docsLookupApiMeta,
  schema as docsLookupApiSchema,
  docsLookupApiHandler,
} from './docs/docs-lookup-api.js';
import {
  meta as assetGetReferencersMeta,
  schema as assetGetReferencersSchema,
  assetGetReferencersHandler,
} from './asset-graph/asset-get-referencers.js';
import {
  meta as assetGetDependenciesMeta,
  schema as assetGetDependenciesSchema,
  assetGetDependenciesHandler,
} from './asset-graph/asset-get-dependencies.js';
import {
  meta as assetGetReferencesMeta,
  schema as assetGetReferencesSchema,
  assetGetReferencesHandler,
} from './asset-graph/asset-get-references.js';
import { meta as assetRenameMeta, schema as assetRenameSchema, assetRenameHandler } from './asset-graph/asset-rename.js';
import { meta as assetMoveMeta, schema as assetMoveSchema, assetMoveHandler } from './asset-graph/asset-move.js';
import {
  meta as assetFixRedirectorsMeta,
  schema as assetFixRedirectorsSchema,
  assetFixRedirectorsHandler,
} from './asset-graph/asset-fix-redirectors.js';
import {
  meta as assetValidateMeta,
  schema as assetValidateSchema,
  assetValidateHandler,
} from './asset-graph/asset-validate.js';
import {
  meta as foliageListTypesMeta, schema as foliageListTypesSchema, foliageListTypesHandler,
} from './foliage/foliage-list-types.js';
import {
  meta as foliageAddInstanceMeta, schema as foliageAddInstanceSchema, foliageAddInstanceHandler,
} from './foliage/foliage-add-instance.js';
import {
  meta as foliagePaintAtMeta, schema as foliagePaintAtSchema, foliagePaintAtHandler,
} from './foliage/foliage-paint-at.js';
import {
  meta as foliageRemoveInstancesMeta, schema as foliageRemoveInstancesSchema, foliageRemoveInstancesHandler,
} from './foliage/foliage-remove-instances.js';
import { meta as pieWidgetTreeMeta, schema as pieWidgetTreeSchema, pieWidgetTreeHandler } from './pie/pie-widget-tree.js';
import { meta as pieClickWidgetMeta, schema as pieClickWidgetSchema, pieClickWidgetHandler } from './pie/pie-click-widget.js';
import { meta as pieMouseMeta, schema as pieMouseSchema, pieMouseHandler } from './pie/pie-mouse.js';
import { meta as pieTypeTextMeta, schema as pieTypeTextSchema, pieTypeTextHandler } from './pie/pie-type-text.js';
import { meta as pieSetTextMeta, schema as pieSetTextSchema, pieSetTextHandler } from './pie/pie-set-text.js';
import { meta as pieAxisMeta, schema as pieAxisSchema, pieAxisHandler } from './pie/pie-axis.js';
import { meta as piePressKeyMeta, schema as piePressKeySchema, piePressKeyHandler } from './pie/pie-press-key.js';
import { meta as pieScreenshotMeta, schema as pieScreenshotSchema, pieScreenshotHandler } from './pie/pie-screenshot.js';
import { meta as textureAuditMeta, schema as textureAuditSchema, textureAuditHandler } from './content/texture-audit.js';
import { meta as meshAuditMeta, schema as meshAuditSchema, meshAuditHandler } from './content/mesh-audit.js';
import {
  meta as contentValidateMeta, schema as contentValidateSchema, contentValidateHandler,
} from './content/content-validate.js';
import { meta as uiBuildTreeMeta, schema as uiBuildTreeSchema, uiBuildTreeHandler } from './ui/ui-build-tree.js';
import {
  meta as uiDuplicateElementMeta,
  schema as uiDuplicateElementSchema,
  uiDuplicateElementHandler,
} from './ui/ui-duplicate-element.js';
import { meta as uiMoveElementMeta, schema as uiMoveElementSchema, uiMoveElementHandler } from './ui/ui-move-element.js';
import {
  meta as uiRenameElementMeta,
  schema as uiRenameElementSchema,
  uiRenameElementHandler,
} from './ui/ui-rename-element.js';
import { meta as uiSetVariableMeta, schema as uiSetVariableSchema, uiSetVariableHandler } from './ui/ui-set-variable.js';
import { meta as uiBindPropertyMeta, schema as uiBindPropertySchema, uiBindPropertyHandler } from './ui/ui-bind-property.js';
import {
  meta as uiListWidgetBlueprintsMeta,
  schema as uiListWidgetBlueprintsSchema,
  uiListWidgetBlueprintsHandler,
} from './ui/ui-list-widget-blueprints.js';
import { meta as uiValidateMeta, schema as uiValidateSchema, uiValidateHandler } from './ui/ui-validate.js';
import { meta as uiMeasureTextMeta, schema as uiMeasureTextSchema, uiMeasureTextHandler } from './ui/ui-measure-text.js';
import {
  meta as uiLayoutSnapshotMeta,
  schema as uiLayoutSnapshotSchema,
  uiLayoutSnapshotHandler,
} from './ui/ui-layout-snapshot.js';
import {
  meta as uiCopyStyleMeta,
  schema as uiCopyStyleSchema,
  uiCopyStyleHandler,
} from './ui/ui-copy-style.js';
import {
  meta as editorSaveAllAndQuitMeta,
  schema as editorSaveAllAndQuitSchema,
  editorSaveAllAndQuitHandler,
} from './editor/editor-save-all-and-quit.js';
import {
  meta as uiSetDefaultFontMeta,
  schema as uiSetDefaultFontSchema,
  uiSetDefaultFontHandler,
} from './ui/ui-set-default-font.js';
import {
  meta as uiRenderWidgetToPngMeta,
  schema as uiRenderWidgetToPngSchema,
  uiRenderWidgetToPngHandler,
} from './ui/ui-render-widget-to-png.js';
import {
  meta as uiRemoveElementMeta,
  schema as uiRemoveElementSchema,
  uiRemoveElementHandler,
} from './ui/ui-remove-element.js';
import {
  meta as uiReparentElementMeta,
  schema as uiReparentElementSchema,
  uiReparentElementHandler,
} from './ui/ui-reparent-element.js';
import {
  meta as uiReplaceElementMeta,
  schema as uiReplaceElementSchema,
  uiReplaceElementHandler,
} from './ui/ui-replace-element.js';
import { worldGenerateHandler, meta as worldGenerateMeta } from './world/world-generate.js';
import {
  providerListHandler,
  providerListMeta,
  providerSetHandler,
  providerSetMeta,
  providerTestHandler,
  providerTestMeta,
  modelListHandler,
  modelListMeta,
  keySetHandler,
  keySetMeta,
  keyClearHandler,
  keyClearMeta,
  keyStatusHandler,
  keyStatusMeta,
  healthHandler,
  healthMeta,
} from './copilot/copilot-tools.js';
import {
  textureGetInfoHandler,
  getInfoMeta as textureGetInfoMeta,
  textureSetCompressionHandler,
  setCompressionMeta as textureSetCompressionMeta,
  textureSetSettingsHandler,
  setSettingsMeta as textureSetSettingsMeta,
  textureListHandler,
  listMeta as textureListMeta,
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
import { pcgScatterMeshHandler, schema as pcgScatterSchema, meta as pcgScatterMeta } from './pcg/pcg-scatter-mesh.js';
import {
  pcgAddNodeDescriptor,
  pcgSetPropDescriptor,
  pcgWireDescriptor,
  pcgInspectInstancesDescriptor,
  pcgRemoveNodeDescriptor,
  pcgDisconnectDescriptor,
  pcgLayoutDescriptor,
  pcgListPinsDescriptor,
  pcgGetNodeDescriptor,
} from './pcg/pcg-primitives.js';
import { actorPyDescriptors } from './actor/actor-py-tools.js';
import { editorPyDescriptors } from './editor/editor-py-tools.js';
import { assetPyDescriptors } from './asset/asset-py-tools.js';
import { meshPyDescriptors } from './mesh/mesh-py-tools.js';
import { sequencerPyDescriptors } from './sequencer/sequencer-py-tools.js';
import { niagaraPyDescriptors } from './niagara/niagara-py-tools.js';
import { waterPyDescriptors } from './water/water-py-tools.js';
import { landscapePyDescriptors } from './landscape/landscape-py-tools.js';
import { foliagePyDescriptors } from './foliage/foliage-py-tools.js';
import { lightingPyDescriptors } from './lighting/lighting-py-tools.js';
import { toToolDescriptor } from './py-tool-factory.js';
import { generateLegacyDescriptors, registerLegacyNonIdempotent } from './legacy-tool-factory.js';

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
  validatorRunSchema,
  validatorRunHandler,
  validatorHistorySchema,
  validatorHistoryHandler,
  validatorResolveSchema,
  validatorResolveHandler,
  validatorClearSchema,
  validatorClearHandler,
  validatorRulesSchema,
  validatorRulesHandler,
  validatorSetRuleEnabledSchema,
  validatorSetRuleEnabledHandler,
  validatorStrictnessHandler,
  validatorStrictnessSchema,
  defaultScratchDir as validatorScratchDir,
} from './validator/tools.js';
import { liveUeProbe } from '../validator/ue-probe.js';

// ── PLUMB constraint subsystem (quantified validator + constraint language) ──
import {
  plumbPrimitivesSchema,
  plumbPrimitivesHandler,
  plumbProfileBakeSchema,
  plumbProfileBakeHandler,
  plumbProfileAnnotateSchema,
  plumbProfileAnnotateHandler,
  plumbProfileListSchema,
  plumbProfileListHandler,
  plumbProfileGetSchema,
  plumbProfileGetHandler,
  plumbConstraintDefineSchema,
  plumbConstraintDefineHandler,
  plumbConstraintListSchema,
  plumbConstraintListHandler,
  plumbConstraintRemoveSchema,
  plumbConstraintRemoveHandler,
  plumbConstraintProposeSchema,
  plumbConstraintProposeHandler,
  plumbValidateSchema,
  plumbValidateHandler,
  plumbMaskAddSchema,
  plumbMaskAddHandler,
  plumbMaskRemoveSchema,
  plumbMaskRemoveHandler,
  plumbLessonAddSchema,
  plumbLessonAddHandler,
  plumbLessonListSchema,
  plumbLessonListHandler,
  plumbLessonRemoveSchema,
  plumbLessonRemoveHandler,
  plumbStudySchema,
  plumbStudyHandler,
  plumbStudyTakeSchema,
  plumbStudyTakeHandler,
  plumbSegmentSchema,
  plumbSegmentHandler,
  plumbProductionDefineSchema,
  plumbProductionDefineHandler,
  plumbProductionListSchema,
  plumbProductionListHandler,
  plumbProductionRemoveSchema,
  plumbProductionRemoveHandler,
  plumbSocketAddSchema,
  plumbSocketAddHandler,
  plumbGrammarExpandSchema,
  plumbGrammarExpandHandler,
} from './plumb/tools.js';

// SessionManager (Gaea session) parked while terrain features are off — kept
// as a typed shim so registerTools' signature doesn't churn for callers.
// briefNicheOnce is used by the first-touch niche briefing system.
type SessionManagerStub = {
  briefNicheOnce?(domain: string): boolean;
  [key: string]: unknown;
};

// ── Shared Zod coercion helpers (module scope) ───────────────────────────────
// Hoisted so the descriptor catalogue is the only
// place each tool's shape is declared — consumed both by recordToolSchema
// (always) and registerTool (eager mode). Previously these were defined twice:
// once for native registration and once for schema seeding, identically.
const dVec3 = z.tuple([z.number(), z.number(), z.number()]);
// Some MCP clients (incl. Claude Code's tool harness) JSON-stringify nested
// arrays/booleans before they hit Zod. Wrap so we accept both raw and the
// stringified form for params we know are commonly affected.
const dCoerceBool = z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean());
const dCoerceVec3 = z.preprocess((v) => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}, dVec3);

/**
 * Single-source tool descriptor list.
 *
 * ## Pattern
 * Each entry is a ToolDescriptor that declares the tool once. The complete
 * STATIC_TOOL_CATALOGUE has three consumers: schema seeding, eager native
 * registration, and direct deferred capture. Rich image results and small
 * orchestration closures are valid descriptor handlers; they are behavior, not
 * a reason to invent a sixth registration path.
 *
 * ## Adding a new tool
 * Add a ToolDescriptor to the appropriate catalogue shard. Do not add a
 * separate server.tool call or schema-registry entry.
 */
const M = 'material'; // niche domain for the material toolset
const UI = 'ui'; // niche domain for the UMG / Widget Blueprint toolset
const PACK = 'copilot'; // niche domain for the BYOK copilot config/introspection toolset
const DOCS = 'docs'; // niche domain for live-editor API reflection
const ASSETGRAPH = 'asset'; // niche domain for asset reference/refactor tools
const FOLIAGE = 'foliage'; // niche domain for foliage placement
const PIE = 'pie'; // niche domain for driving a running game
const CONTENT = 'content'; // niche domain for content audits and budgets
// Hand-written descriptors. Kept as a named const so the generated legacy list
// can be de-duplicated against these names before splicing (see below).

// ── Validator tools ────────────────────────────────────────────────────────
//
// Previously registered by hand, which left them outside the registrar and so
// outside appendMeta, the response-evidence contract and the validation nudge.
// Notably validator_set_rule_enabled and validator_clear persist state while
// declaring no effects at all, because the hand-written form had nowhere to put
// them. Expressing effects as data is most of the point of this conversion.
//
// USE_WHEN / NOT_WHEN guidance moved out of the description prose into meta,
// where appendMeta renders it — the descriptions had been carrying it inline.
export const VALIDATOR_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'validator_run',
    description:
      'CATCHES SILENT WRONGNESS YOU CANNOT SEE: runs the validator rules over the current scene and returns concrete post-condition findings \u2014 actors floating above ground, interpenetrating meshes, off-grid/mis-scaled placements, missing expected results, and PLUMB constraint violations. Pass scope=\'all\' (default) or { rule_ids: [...] }; findings persist to history and the Validation panel. WHY: you have no viewport \u2014 this is how you verify placement actually landed correctly instead of assuming it did.',
    meta: {
      cost: 'high',
      effects: ['persists_validator_findings'],
      when: 'after ANY scene mutation (spawn / move / delete / scatter / foliage / PCG execute / world_generate / landscape / lighting change), AND before you declare a task done or report success',
      not_when: 'you have made no scene change since the last run',
    },
    schema: validatorRunSchema,
    cost: 'high',
    returns: '{findings:[{rule_id,severity,message,hint,refs}], counts, ran, scope}',
    handler: async (args) =>
      okResult(
        await validatorRunHandler(args as { scope?: 'all' | { rule_ids?: string[] }; persist?: boolean }, {
          probe: liveUeProbe,
          scratchDir: validatorScratchDir(),
        }),
      ),
  },
  {
    name: 'validator_history',
    description:
      'Read persisted validator findings (the record of everything validator_run / plumb_validate caught). Filter by limit / since_iso / include_resolved / rule_ids.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'reviewing what is still wrong in the scene, checking whether a prior fix cleared a finding, or reporting outstanding issues to the user',
      not_when: 'you want a fresh evaluation \u2014 call validator_run instead; history only shows past findings',
    },
    schema: validatorHistorySchema,
    cost: 'low',
    returns: '{findings:[{timestamp,rule_id,severity,message,resolved}], total}',
    handler: async (args) =>
      okResult(
        await validatorHistoryHandler(
          args as { limit?: number; since_iso?: string; include_resolved?: boolean; rule_ids?: string[] },
        ),
      ),
  },
  {
    name: 'validator_resolve',
    description: 'Mark a validator finding as resolved (or restore it). Identifies the finding by its ISO timestamp.',
    meta: {
      cost: 'low',
      effects: ['modifies_validator_history'],
      when: 'you have fixed what a finding reported and want it cleared from the outstanding list',
      not_when: 'the finding is still true \u2014 resolving it hides a real problem rather than fixing it',
    },
    schema: validatorResolveSchema,
    cost: 'low',
    returns: '{ok, timestamp, resolved}',
    handler: async (args) => okResult(await validatorResolveHandler(args as { timestamp: string; resolved: boolean })),
  },
  {
    name: 'validator_clear',
    description: 'Clear the validator history. Requires { confirm: true } to actually wipe.',
    meta: {
      cost: 'low',
      effects: ['clears_validator_history'],
      when: 'starting a fresh session on a scene and the accumulated findings are noise',
      not_when: 'you simply want to hide outstanding problems \u2014 the history is the record that they exist',
    },
    schema: validatorClearSchema,
    cost: 'low',
    returns: '{ok, cleared}',
    handler: async (args) => okResult(await validatorClearHandler(args as { confirm: boolean })),
  },
  {
    name: 'validator_rules',
    description:
      "List the validator rule catalog \u2014 every post-condition check and bound PLUMB constraint that validator_run / plumb_validate will evaluate, with each rule's message, hint, refs, and disabled state.",
    meta: {
      cost: 'low',
      effects: [],
      when: 'you want to know WHAT validation can catch before running it, or to confirm the right rule is enabled for the task at hand',
      not_when: 'you just want to run the checks \u2014 call validator_run',
    },
    schema: validatorRulesSchema,
    cost: 'low',
    returns: '{rules:[{id,message,hint,refs,disabled,min_strictness}]}',
    handler: async (args) => okResult(await validatorRulesHandler(args as { include_disabled_state?: boolean })),
  },
  {
    name: 'validator_set_rule_enabled',
    description: 'Enable or disable a validator rule by id. Persists to .scratch/validator-config.json.',
    meta: {
      cost: 'low',
      effects: ['modifies_validator_config'],
      when: 'a rule is firing on something intentional in this project and the noise outweighs the signal',
      not_when: 'the rule is right and the scene is wrong \u2014 disabling it silences the report, not the problem',
    },
    schema: validatorSetRuleEnabledSchema,
    cost: 'low',
    returns: '{ok, rule_id, enabled}',
    handler: async (args) =>
      okResult(await validatorSetRuleEnabledHandler(args as { rule_id: string; enabled: boolean })),
  },
  {
    name: 'validator_strictness',
    description:
      'Read or set validation strictness. Three modes \u2014 relaxed (only what is broken), standard (plus established conventions), strict (plus house-style polish) \u2014 set globally or per category (ui, pcg, landscape, material, blueprint, python, asset, general). A rule declares the lowest mode at which it fires, so raising strictness only ever adds findings. Call with no arguments to read the current settings. Persists to .scratch/validator-config.json, the same file the editor Configure panel reads.',
    meta: {
      cost: 'low',
      effects: ['modifies_validator_config'],
      when: 'tuning how much the validator reports, globally or for one category',
      not_when: 'you only want to read the current mode \u2014 that is the same call with no arguments, and it writes nothing',
    },
    schema: validatorStrictnessSchema,
    cost: 'low',
    returns: '{global, categories:{ui,pcg,landscape,material,blueprint,python,asset,general}}',
    handler: async (args) =>
      okResult(await validatorStrictnessHandler(args as Parameters<typeof validatorStrictnessHandler>[0])),
  },
];


// ── PLUMB tools ────────────────────────────────────────────────────
//
// Effects were determined by reading each handler body, not inferred from the
// verb in its name: plumb_study_take persists via upsertLesson despite reading
// like a query, while constraint_propose, segment and grammar_expand compute
// and store nothing despite sounding like authoring tools.
export const PLUMB_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'plumb_primitives',
    description: 'List the COMPLETE closed constraint grammar — the 10 primitives, their gate, hard/soft default, params, and docs. Author constraints by picking one and filling params.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'you need the CLOSED set of primitives a constraint or production may legally reference',
      not_when: 'you want a specific asset profile - use plumb_profile_get',
    },
    schema: plumbPrimitivesSchema,
    cost: 'low',
    returns: '{primitives:[{name,kind,attrs}]}',
    handler: async () => okResult(await plumbPrimitivesHandler()),
  },
  {
    name: 'plumb_profile_bake',
    description: 'Bake the deterministic geometry/physics half of a Physical Asset Profile. Pass just the asset to auto-fetch bounds from UE (mesh_get_info), or supply origin_cm + extent_cm (+ optional pivot_to_base_cm) explicitly. Persists to the profile store.',
    meta: {
      cost: 'low',
      effects: ['bakes_plumb_profile'],
      when: 'a mesh needs a measured profile before constraints or grammar can reference it',
      not_when: 'the profile is already baked and unchanged - plumb_profile_get reads it',
    },
    schema: plumbProfileBakeSchema,
    cost: 'low',
    returns: '{ok, asset, profile:{bounds,sockets,attrs}}',
    handler: async (a) => okResult(await plumbProfileBakeHandler(a as Parameters<typeof plumbProfileBakeHandler>[0], new Date().toISOString(), fetchMeshBounds)),
  },
  {
    name: 'plumb_profile_annotate',
    description: 'Layer AI/human qualitative semantics (class, up/front vectors, named affordance regions) onto a baked profile, with optional field locks. Qualitative constraints can only hard-gate on locked fields.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_profile'],
      when: 'a baked profile needs a human-meaningful tag the solver can bind to',
      not_when: 'the annotation belongs on a constraint instead',
    },
    schema: plumbProfileAnnotateSchema,
    cost: 'low',
    returns: '{ok, asset, annotations}',
    handler: async (a) => okResult(await plumbProfileAnnotateHandler(a as Parameters<typeof plumbProfileAnnotateHandler>[0])),
  },
  {
    name: 'plumb_profile_list',
    description: 'List baked profiles (asset_id, archetype, affordance count, locked fields). Feeds the Memory tab.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'you want to know which assets already have baked profiles',
      not_when: 'you need one profile in full - plumb_profile_get',
    },
    schema: plumbProfileListSchema,
    cost: 'low',
    returns: '{profiles:[{asset,baked_at}]}',
    handler: async () => okResult(await plumbProfileListHandler()),
  },
  {
    name: 'plumb_profile_get',
    description: 'Fetch one full Physical Asset Profile by asset path.',
    meta: {
      cost: 'low',
      effects: [],
      when: "you need one asset's baked bounds, sockets and attributes",
      not_when: "you only want to know whether it exists - plumb_profile_list is cheaper",
    },
    schema: plumbProfileGetSchema,
    cost: 'low',
    returns: '{asset, bounds, sockets, attrs, masks}',
    handler: async (a) => okResult(await plumbProfileGetHandler(a as Parameters<typeof plumbProfileGetHandler>[0])),
  },
  {
    name: 'plumb_constraint_define',
    description: 'Author/upsert a bound constraint: a primitive id + params + a binding (exactly one of {asset, tag}). Validated against the closed primitive set — invalid primitives/params/bindings are rejected.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_constraints'],
      when: 'expressing a placement rule that must hold, in the closed constraint language',
      not_when: 'the rule is a one-off check - plumb_validate takes ad-hoc scope',
    },
    schema: plumbConstraintDefineSchema,
    cost: 'low',
    returns: '{ok, id, constraint, validated}',
    handler: async (a) => okResult(await plumbConstraintDefineHandler(a as Parameters<typeof plumbConstraintDefineHandler>[0])),
  },
  {
    name: 'plumb_constraint_list',
    description: 'List the constraint library (optionally filtered to an asset binding).',
    meta: {
      cost: 'low',
      effects: [],
      when: 'reviewing which placement rules are currently in force',
      not_when: 'you want to know whether the scene SATISFIES them - plumb_validate',
    },
    schema: plumbConstraintListSchema,
    cost: 'low',
    returns: '{constraints:[{id,kind,bound_to}]}',
    handler: async (a) => okResult(await plumbConstraintListHandler(a as Parameters<typeof plumbConstraintListHandler>[0])),
  },
  {
    name: 'plumb_constraint_remove',
    description: 'Remove a constraint from the library by id.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_constraints'],
      when: 'a constraint is wrong or obsolete and should stop being enforced',
      not_when: 'the constraint is right and the scene is wrong - fix the scene',
    },
    schema: plumbConstraintRemoveSchema,
    cost: 'low',
    returns: '{ok, id, removed}',
    handler: async (a) => okResult(await plumbConstraintRemoveHandler(a as Parameters<typeof plumbConstraintRemoveHandler>[0])),
  },
  {
    name: 'plumb_constraint_propose',
    description: 'Draft (does not save) constraints for an asset from its baked profile, using only closed primitives. Review/edit then call plumb_constraint_define.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'you want candidate constraints inferred from what is already placed, to review before defining',
      not_when: 'you already know the rule - plumb_constraint_define writes it directly',
    },
    schema: plumbConstraintProposeSchema,
    cost: 'low',
    returns: '{proposals:[{constraint,support,confidence}]} - nothing is persisted',
    handler: async (a) => okResult(await plumbConstraintProposeHandler(a as Parameters<typeof plumbConstraintProposeHandler>[0])),
  },
  {
    name: 'plumb_validate',
    description: 'VERIFY PLACEMENT IS ACTUALLY CORRECT: runs the PLUMB constraint library over a set of instances and returns a directional Verdict — per-gate ok, signed value_m (how far off, and which way), and a FixVector telling you exactly how to move each instance to satisfy it. Catches grounding, clearance, alignment, spacing and interpenetration violations the viewport would reveal but you cannot. Hard fails set stopped_at; soft fails accumulate soft_cost. WHY: this is the quantified check that turns "looks placed" into "provably grounded and non-overlapping".',
    meta: {
      cost: 'medium',
      effects: ['persists_validator_findings'],
      when: 'immediately after placing/scattering/spawning/transforming instances, and before declaring the layout done — feed the FixVector back into a transform to correct, then re-validate',
      not_when: 'no constraints are bound for these assets — check plumb_constraint_list / validator_rules first',
    },
    schema: plumbValidateSchema,
    cost: 'medium',
    returns: '{findings:[{constraint_id,severity,message,actors}], counts, passes}',
    handler: async (a) => okResult(await plumbValidateHandler(a as Parameters<typeof plumbValidateHandler>[0])),
  },
  {
    name: 'plumb_mask_add',
    description: 'Add or update a mask (surface = triangle set; volume = translucent shape) on a baked profile. Surface/volume masks are the regions constraints reference.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_profile'],
      when: 'part of a profile must be excluded from constraint solving',
      not_when: 'the whole asset should be excluded - remove its profile',
    },
    schema: plumbMaskAddSchema,
    cost: 'low',
    returns: '{ok, asset, mask_id}',
    handler: async (a) => okResult(await plumbMaskAddHandler(a as Parameters<typeof plumbMaskAddHandler>[0])),
  },
  {
    name: 'plumb_mask_remove',
    description: 'Remove a mask from a profile by id.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_profile'],
      when: 'a mask is over-excluding and constraints should see that region again',
      not_when: 'you want to keep the mask but change its extent - add a replacement',
    },
    schema: plumbMaskRemoveSchema,
    cost: 'low',
    returns: '{ok, asset, mask_id, removed}',
    handler: async (a) =>
    okResult(await plumbMaskRemoveHandler(a as Parameters<typeof plumbMaskRemoveHandler>[0])),
  },
  {
    name: 'plumb_lesson_add',
    description: 'Add/update a lesson — the durable [[slug]] knowledge that explains WHY a constraint exists (browsed in the Studio Lessons panel; cited by constraint/validator refs).',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_lessons'],
      when: 'recording WHY a constraint exists, so a future reader does not delete it as noise',
      not_when: 'the note is about one scene rather than a durable rule',
    },
    schema: plumbLessonAddSchema,
    cost: 'low',
    returns: '{ok, slug, title}',
    handler: async (a) => okResult(await plumbLessonAddHandler(a as Parameters<typeof plumbLessonAddHandler>[0], new Date().toISOString())),
  },
  {
    name: 'plumb_lesson_list',
    description: 'List lessons (slug + title + refs).',
    meta: {
      cost: 'low',
      effects: [],
      when: 'finding the durable knowledge behind the current constraint set',
      not_when: 'you want the constraints themselves - plumb_constraint_list',
    },
    schema: plumbLessonListSchema,
    cost: 'low',
    returns: '{lessons:[{slug,title,refs}]}',
    handler: async () =>
    okResult(await plumbLessonListHandler()),
  },
  {
    name: 'plumb_lesson_remove',
    description: 'Remove a lesson by slug.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_lessons'],
      when: 'a lesson has been superseded and would mislead',
      not_when: 'the lesson is still true but the constraint changed - update the lesson',
    },
    schema: plumbLessonRemoveSchema,
    cost: 'low',
    returns: '{ok, slug, removed}',
    handler: async (a) =>
    okResult(await plumbLessonRemoveHandler(a as Parameters<typeof plumbLessonRemoveHandler>[0])),
  },
  {
    name: 'plumb_study',
    description: "AI study entry point: returns the asset's baked profile (if any) + the closed primitive grammar + mask kinds + guidance, so the agent can propose masks (plumb_mask_add) and constraints (plumb_constraint_define).",
    meta: {
      cost: 'low',
      effects: [],
      when: 'orienting on an asset before authoring constraints - returns its profile plus the legal primitives',
      not_when: 'you already know the asset and just need its numbers - plumb_profile_get',
    },
    schema: plumbStudySchema,
    cost: 'low',
    returns: '{asset, profile, primitives, constraints}',
    handler: async (a) => okResult(await plumbStudyHandler(a as Parameters<typeof plumbStudyHandler>[0])),
  },
  {
    name: 'plumb_study_take',
    description: 'Drain pending "Study with AI" requests from the Semantic Studio button. Returns the assets to study (then call plumb_study + author masks/constraints for each).',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_lessons'],
      when: 'committing what a study concluded as a durable lesson',
      not_when: 'you are still exploring - plumb_study reads without recording',
    },
    schema: plumbStudyTakeSchema,
    cost: 'low',
    returns: '{ok, slug, lesson}',
    handler: async () => okResult(await plumbStudyTakeHandler()),
  },
  {
    name: 'plumb_segment',
    description: "AI-segment a studied asset: given the study_render color passes, the agent's themed part labels + a box/points per view, runs SAM in the visual sidecar and back-projects to geometry-hugging surface masks (triangles via the world-position pass + a UV display texture), written into the profile. Replaces hand-placed blocky masks.",
    meta: {
      cost: 'low',
      effects: [],
      when: 'splitting a run or surface into placeable spans before scattering',
      not_when: 'you want to validate what is already placed - plumb_validate',
    },
    schema: plumbSegmentSchema,
    cost: 'low',
    returns: '{segments:[{start,end,length}]} - computed, not persisted',
    handler: async (a) => okResult(await plumbSegmentHandler(a as Parameters<typeof plumbSegmentHandler>[0])),
  },
  {
    name: 'plumb_production_define',
    description: 'Author/upsert a grammar production rule: an LHS symbol kind (+ optional attribute guards) → an RHS sequence of emit ops (shell/asset/symbol/scatter/decal/fill). Guards are constraint ids that must pass before the production fires.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_grammar'],
      when: 'adding a grammar production that expands one symbol into placed parts',
      not_when: 'the rule is a constraint on placement rather than a way to generate it',
    },
    schema: plumbProductionDefineSchema,
    cost: 'low',
    returns: '{ok, id, production}',
    handler: async (a) => okResult(await plumbProductionDefineHandler(a as Parameters<typeof plumbProductionDefineHandler>[0])),
  },
  {
    name: 'plumb_production_list',
    description: 'List all grammar productions in the store.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'reviewing the grammar currently available to expansion',
      not_when: 'you want the result of expanding it - plumb_grammar_expand',
    },
    schema: plumbProductionListSchema,
    cost: 'low',
    returns: '{productions:[{id,symbol,expansion}]}',
    handler: async () => okResult(await plumbProductionListHandler()),
  },
  {
    name: 'plumb_production_remove',
    description: 'Remove a grammar production by id.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_grammar'],
      when: 'a production generates the wrong shape and should stop being used',
      not_when: 'you want to keep it but change it - define a replacement with the same id',
    },
    schema: plumbProductionRemoveSchema,
    cost: 'low',
    returns: '{ok, id, removed}',
    handler: async (a) =>
    okResult(await plumbProductionRemoveHandler(a as Parameters<typeof plumbProductionRemoveHandler>[0])),
  },
  {
    name: 'plumb_socket_add',
    description: 'Add or replace a socket (connection point) on a baked profile. Idempotent on socket id.',
    meta: {
      cost: 'low',
      effects: ['modifies_plumb_profile'],
      when: 'a baked profile needs a named connection point for the grammar to join against',
      not_when: 'the point is an exclusion rather than a join - plumb_mask_add',
    },
    schema: plumbSocketAddSchema,
    cost: 'low',
    returns: '{ok, asset, socket}',
    handler: async (a) => okResult(await plumbSocketAddHandler(a as Parameters<typeof plumbSocketAddHandler>[0])),
  },
  {
    name: 'plumb_grammar_expand',
    description: 'Expand a seed symbol using the stored production rules + the PLUMB constraint store as guards. Returns a PlacementPlan. In dry-run (no UE scene), geometry-dependent constraints self-skip — rejections only reflect TS-evaluable constraints.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'previewing what the grammar produces from a symbol, before anything is placed',
      not_when: 'you want it actually placed in the scene - that is a separate spawn step',
    },
    schema: plumbGrammarExpandSchema,
    cost: 'low',
    returns: '{expansion:[{symbol,parts}]} - computed, nothing placed',
    handler: async (a) => okResult(await plumbGrammarExpandHandler(a as Parameters<typeof plumbGrammarExpandHandler>[0])),
  },
];


// ── PCG authoring, conventions, zones and landscape ─────────────────
//
// Most of these were registered with the THREE-argument server.tool(name,
// schema, handler) form, i.e. with no description at all: the agent saw a name
// and a parameter list and nothing else, which also made them close to
// invisible to description-based tool search. Descriptions are authored here.
//
// Effects were read out of each implementation, and three contradict the verb
// in the tool's name: hayba_setup_conventions calls writeProjectConventions,
// hayba_set_painter_heightmap calls setHeightmap, and hayba_open_zone_painter
// CREATES a project rather than merely opening one. Conversely
// hayba_abstract_to_subgraph and hayba_parameterize_graph_inputs only transform
// a graph object in memory despite reading like authoring tools.
export const PCG_DESCRIPTORS: ToolDescriptor[] = [
  defineTool({
    name: 'hayba_propose_plan',
    description: 'Propose a step-by-step plan to the user before performing destructive operations. Required when Plan Mode is on. Steps may be strings or {title, description, tool} objects.',
    meta: {
      cost: 'low',
      effects: ['modifies_plan_state'],
      when: 'pushing the steps of a destructive operation to the Plan panel for approval',
      not_when: 'the operation is read-only - Plan Mode gates mutations',
    },
    schema: {
      steps: z
        .array(
          z.union([
            z.string(),
            z.object({
              title: z.string(),
              description: z.string().optional(),
              tool: z.string().optional(),
            }),
          ]),
        )
        .describe('Ordered list of plan steps'),
      await_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe('How long the agent will wait for human approval (informational; default 30)'),
    },
    cost: 'low',
    returns: '{ok, steps, plan_id}',
    handler: async (params) => {
      try {
        const data = await executeCommand('hayba_propose_plan', params as Record<string, unknown>, { timeout: 5000 });
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error pushing plan to UE: ${(e as Error).message}`);
      }
    },
  }),
  defineTool({
    name: 'hayba_mark_plan_step',
    description: 'Update the status of a single step in the proposed plan shown in the UE Plan panel. Marking a step "completed" auto-advances the next step to "running". Call this as you work through an approved plan so the user sees live progress.',
    meta: {
      cost: 'low',
      effects: ['modifies_plan_state'],
      when: 'reporting progress through an approved plan so the panel tracks it',
      not_when: 'no plan is active',
    },
    schema: {
      index: z.number().int().min(0).describe('Zero-based index of the plan step to update'),
      status: z
        .enum(['running', 'completed', 'failed'])
        .default('completed')
        .describe('New status for the step (default "completed")'),
    },
    cost: 'low',
    returns: '{ok, step, status}',
    handler: async (params) => {
      try {
        const data = await executeCommand('plan_mark_step', params as Record<string, unknown>, { timeout: 5000 });
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error marking plan step in UE: ${(e as Error).message}`);
      }
    },
  }),
  defineTool({
    name: 'pcg_cook_and_wait',
    description: appendMeta(
      "Regenerate an actor's PCGComponent, block on the PCG graph settling (NOT world_tick), and return per-mesh ISM instance counts — all in one call.",
      pcgCookMeta,
    ),
    meta: {
      cost: 'high',
      effects: ['executes_pcg_graph'],
      when: 'you need a PCG graph cooked AND the editor settled before reading results',
      not_when: 'you only want to trigger the cook - this also waits',
    },
    schema: pcgCookSchema.shape,
    cost: 'high',
    returns: '{ok, cooked, idle, elapsed_ms}',
    handler: async (params) => {
      const r = await pcgCookAndWaitHandler(params as never);
      return { content: r.content, isError: r.isError };
    },
  }),
  defineTool({
    name: 'pcg_scatter_mesh',
    description: appendMeta(
      'Scatter a mesh (or weighted mesh set) across a surface in ONE call — build the jittered PCG graph, spawn a bound PCGVolume, generate, and return instance counts. Hard-fails on 0 instances.',
      pcgScatterMeta,
    ),
    meta: {
      cost: 'high',
      effects: ['executes_pcg_scatter', 'modifies_scene'],
      when: 'scattering a mesh across a surface through PCG',
      not_when: 'you want placement proven before it lands - world_generate validates first',
    },
    schema: pcgScatterSchema.shape,
    cost: 'high',
    returns: '{ok, points, actor, cooked}',
    handler: async (params) => {
      const r = await pcgScatterMeshHandler(params as never);
      return { content: r.content, isError: r.isError };
    },
  }),
  defineTool({
    name: 'hayba_search_node_catalog',
    description: 'Find a PCG or PCGEx node by what you want it to DO, searching the node catalog by intent rather than by exact type name.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'you know the effect you want but not which node produces it',
      not_when: 'you already know the node type - hayba_get_node_details',
    },
    schema: { query: z.string().describe('Search query — keyword, node class, or category') },
    cost: 'low',
    returns: '{nodes:[{type,title,summary,pins}]}',
    handler: async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_get_node_details',
    description: 'Full detail for one PCG/PCGEx node type: its exact input/output pins, properties and defaults.',
    meta: {
      cost: 'low',
      effects: [],
      when: "you need a node's exact pin names and properties before wiring it",
      not_when: "you are still looking for the right node - hayba_search_node_catalog",
    },
    schema: { class: z.string().describe('PCGEx node class name') },
    cost: 'low',
    returns: '{type, pins:[{name,direction,type}], properties}',
    handler: async (params) => {
    const result = await getNodeDetails({ class: params.class });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_create_pcg_graph',
    description: 'Author a new PCG graph asset from a node and edge description.',
    meta: {
      cost: 'medium',
      effects: ['creates_pcg_graph'],
      when: 'building a new PCG graph from scratch',
      not_when: 'the graph already exists - edit it instead of recreating',
    },
    schema: {
      graph: z.string().describe('JSON string of the PCGEx graph topology'),
      name: z.string().describe('Asset name for the new PCGGraph'),
    },
    cost: 'medium',
    returns: '{ok, path, nodes, edges}',
    handler: async ({ graph, name }) => {
      const result = await createPcgGraph({ graph, name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_validate_pcg_graph',
    description: 'Check a PCG graph for disconnected pins, type mismatches and dead branches WITHOUT cooking it.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'before executing a graph, to catch wiring faults cheaply',
      not_when: 'you want to know what the graph produces - execute it',
    },
    schema: { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    cost: 'low',
    returns: '{valid, issues:[{node,pin,problem}]}',
    handler: async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_list_pcg_assets',
    description: 'List the PCG graph assets that exist in the project.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'discovering which graphs are already available',
      not_when: 'you need one graph in full - export it',
    },
    schema: { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    cost: 'low',
    returns: '{assets:[{path,name}]}',
    handler: async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_export_pcg_graph',
    description: 'Export an existing PCG graph as JSON so it can be inspected or transformed.',
    meta: {
      cost: 'medium',
      effects: ['writes_export_file'],
      when: 'reading a graph out of the project to inspect or edit it',
      not_when: 'you only need the node list - hayba_get_graph_state is cheaper',
    },
    schema: { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    cost: 'medium',
    returns: '{ok, path, graph:{nodes,edges}}',
    handler: async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_execute_pcg_graph',
    description: 'Run a PCG graph so it generates content in the level.',
    meta: {
      cost: 'high',
      effects: ['executes_pcg_graph', 'modifies_scene'],
      when: 'you want the graph to actually produce geometry in the world',
      not_when: 'you only want to check the graph is sound - hayba_validate_pcg_graph',
    },
    schema: { assetPath: z.string().describe('Full UE asset path to execute') },
    cost: 'high',
    returns: '{ok, generated, actors, elapsed_ms}',
    handler: async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_scrape_node_registry',
    description: 'Rebuild the PCGEx node registry from the installed plugin - the SQLite catalog that node search reads.',
    meta: {
      cost: 'high',
      effects: ['rebuilds_node_registry'],
      when: 'node search returns nothing or the registry is stale after a plugin update',
      not_when: 'the registry is current - this rebuilds it from scratch',
    },
    schema: {
      pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/ directory'),
      outputDbPath: z.string().optional().describe('Output SQLite DB path (default: Resources/pcgex_registry.db)'),
      forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
    },
    cost: 'high',
    returns: '{ok, nodes, pins, properties, db_path}',
    handler: async (params) => {
      const result = await scrapeNodeRegistry(params as unknown as ScrapeNodeRegistryParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_match_pin_names',
    description: 'Suggest the correct pin names for an edge between two nodes.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'two nodes will not connect and you need the right pin names',
      not_when: 'you already have valid pin names',
    },
    schema: {
      fromClass: z.string().describe('Source node class'),
      fromPin: z.string().describe('Pin name on source node (may be approximate)'),
      toClass: z.string().describe('Target node class to find a matching input pin on'),
    },
    cost: 'low',
    returns: '{matches:[{from,to,confidence}]}',
    handler: async (params) => {
      const result = await matchPinNames(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_validate_attribute_flow',
    description: 'Trace attributes through a graph and report where the chain breaks.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'attributes vanish downstream and you need to find where',
      not_when: 'the graph does not use attributes',
    },
    schema: {
      graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
      strictMode: dCoerceBool.optional().describe('If true, also flag orphan writes (written but never consumed)'),
    },
    cost: 'low',
    returns: '{ok, breaks:[{node,attribute,reason}]}',
    handler: async (params) => {
      const result = await validateAttributeFlow(params as unknown as ValidateAttributeFlowParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_diff_against_working_asset',
    description: 'Compare a graph description against the asset currently in the project.',
    meta: {
      cost: 'medium',
      effects: [],
      when: 'checking what your edits would change before writing them',
      not_when: 'you want the asset contents alone - export it',
    },
    schema: {
      wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
      referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
      diffMode: z.enum(['structural', 'properties', 'full']).optional().describe('What to diff (default: full)'),
    },
    cost: 'medium',
    returns: '{added, removed, changed}',
    handler: async (params) => {
      const result = await diffAgainstWorkingAsset(params as unknown as DiffAgainstWorkingAssetParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_format_graph_topology',
    description: 'Render a graph as readable topology text.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'reasoning about a graph structure in a readable form',
      not_when: 'you need machine-readable JSON - export it',
    },
    schema: {
      graph: z
        .string()
        .describe(
          'JSON string of the PCGEx graph to layout. ' +
            'Edges accept either canonical (fromNode/fromPin/toNode/toPin) or legacy (from/fromPin/to/toPin) keys. ' +
            'Output nodes carry a position:{x,y} object; the C++ legacy handler reads that.',
        ),
      algorithm: z.enum(['layered', 'grid']).optional().describe('Layout algorithm (default: layered)'),
      nodeWidth: z.number().int().optional().describe('Node width in pixels (default: 200)'),
      nodeHeight: z.number().int().optional().describe('Node height in pixels (default: 100)'),
      horizontalSpacing: z.number().int().optional().describe('Horizontal gap between layers (default: 150)'),
      verticalSpacing: z.number().int().optional().describe('Vertical gap between rows (default: 80)'),
      addCommentBlocks: z.boolean().optional().describe('Wrap category clusters in PCGComment nodes'),
    },
    cost: 'low',
    returns: '{topology}',
    handler: async (params) => {
      const result = await formatGraphTopology(params as unknown as FormatGraphTopologyParams);
      return { content: [{ type: 'text', text: result }] };
    },
  }),
  defineTool({
    name: 'hayba_abstract_to_subgraph',
    description: 'Extract a repeated node cluster into a reusable subgraph. Transforms the graph object in memory and writes nothing.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'the same cluster appears several times and should be factored out',
      not_when: 'the cluster is used once - abstracting it only adds indirection',
    },
    schema: {
      graph: z.string().describe('JSON string of the full PCGEx graph'),
      nodeIds: z.array(z.string()).describe('Array of node IDs to extract into a subgraph'),
      subgraphName: z.string().optional().describe('Name for the extracted subgraph (default: SubGraph)'),
    },
    cost: 'low',
    returns: '{graph, subgraph, replaced} - in memory, nothing written',
    handler: async (params) => {
      const result = await abstractToSubgraph(params as unknown as AbstractToSubgraphParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_parameterize_graph_inputs',
    description: 'Promote hard-coded values in a graph to named inputs. Transforms the graph object in memory and writes nothing.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'making a graph reusable across biomes or scales',
      not_when: 'the values are genuinely fixed for this graph',
    },
    schema: {
      graph: z.string().describe('JSON string of the PCGEx graph'),
      targets: z
        .array(
          z.object({
            nodeId: z.string().describe('Node ID containing the hardcoded property'),
            property: z.string().describe('Property name to parameterize'),
            parameterName: z.string().optional().describe('Name for the graph parameter'),
          }),
        )
        .describe('List of properties to promote to graph parameters'),
    },
    cost: 'low',
    returns: '{graph, parameters:[{name,type,default}]} - in memory',
    handler: async (params) => {
      const result = await parameterizeGraphInputs(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_query_pcgex_docs',
    description: 'Search the PCGEx documentation for a node or concept.',
    meta: {
      cost: 'low',
      effects: [],
      when: "you need PCGEx reference material while authoring a graph",
      not_when: "the question is about this project's own graphs - search the catalog",
    },
    schema: {
      query: z.string().describe('Node class name or keyword to search documentation'),
      includeSourceSnippet: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include up to 80 lines from the header file'),
    },
    cost: 'low',
    returns: '{results:[{title,excerpt,ref}]}',
    handler: async (params) => {
      const result = await queryPcgexDocs(params as unknown as QueryPcgexDocsParams);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  }),
  defineTool({
    name: 'hayba_initiate_infrastructure_brainstorm',
    description: 'Plan complex graph architectures. IMPORTANT: After calling this tool, do NOT call hayba_create_pcg_graph, hayba_validate_pcg_graph, or any graph-mutation tool until the user explicitly approves an approach from the proposal.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'starting a structured design pass over world infrastructure',
      not_when: 'you already know what to build',
    },
    schema: {
      topic: z.string().describe('The infrastructure or system design topic to brainstorm'),
      context: z.string().optional().describe('Additional context about the project or constraints'),
      constraints: z.array(z.string()).optional().describe('Explicit constraints or requirements'),
    },
    cost: 'low',
    returns: '{prompt, considerations}',
    handler: async (params) => {
      const result = await initiateInfrastructureBrainstorm(params);
      return {
        content: [
          {
            type: 'text',
            text:
              JSON.stringify(result, null, 2) +
              '\n\n---\nIMPORTANT: This is a PROPOSAL ONLY. Do NOT call hayba_create_pcg_graph, ' +
              'hayba_validate_attribute_flow, hayba_abstract_to_subgraph, or any graph-mutation tool ' +
              'until the user has explicitly approved an approach above.',
          },
        ],
      };
    },
  }),
  defineTool({
    name: 'hayba_setup_conventions',
    description: 'Multi-turn wizard to configure UE project conventions. Call repeatedly with advancing stages.',
    meta: {
      cost: 'low',
      effects: ['writes_conventions_file'],
      when: 'setting or changing where generated content should be placed and how it is named',
      not_when: 'you only want to read the current conventions - hayba_analyze_conventions',
    },
    schema: {
      stage: z.enum(['start', 'folders', 'naming', 'workflow', 'confirm', 'save']).describe('Current wizard stage'),
      preset: z
        .enum(['epic-default', 'gamedevtv', 'custom'])
        .optional()
        .describe('Preset to load (required at start stage)'),
      answers: z.record(z.string(), z.unknown()).optional().describe('Accumulated user responses from previous stages'),
      target: z.enum(['global', 'project']).optional().describe('Where to save (required at save stage)'),
      projectRoot: z.string().optional().describe('UE project root path (required if target is project)'),
    },
    cost: 'low',
    returns: '{ok, stage, conventions, written_to}',
    handler: async (params) => {
      const result = await setupConventionsHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    },
  }),
  defineTool({
    name: 'hayba_analyze_conventions',
    description: 'Scan a UE project Content directory and infer conventions from existing folder structure and asset naming.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'auditing whether the project follows its own conventions',
      not_when: 'you want to CHANGE them - hayba_setup_conventions',
    },
    schema: {
      projectRoot: z.string().describe('Path to UE project root (contains .uproject file)'),
      save: z.boolean().optional().describe('If true, write inferred conventions to target (default: false — dry run)'),
      target: z.enum(['global', 'project']).optional().describe('Where to save (required when save is true)'),
    },
    cost: 'low',
    returns: '{conventions, violations:[{path,rule}]}',
    handler: async (params) => {
      const result = await analyzeConventionsHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    },
  }),
  defineTool({
    name: 'hayba_open_zone_painter',
    description: 'Open the zone painter for a world. CREATES the project when it does not already exist.',
    meta: {
      cost: 'low',
      effects: ['creates_zone_project'],
      when: 'starting or reopening a zone-painting session',
      not_when: 'you only want to read painted zones - hayba_read_zones',
    },
    schema: {
      projectId: z.string().optional().describe('Existing project ID. Omit to create a new project.'),
      projectName: z.string().optional().describe('Name for the new project (used when projectId is omitted).'),
      phase: z
        .enum(['a', 'b'])
        .optional()
        .describe('Phase A = blank canvas, Phase B = heightmap overlay (default: a).'),
    },
    cost: 'low',
    returns: '{ok, projectId, url, created}',
    handler: async (params) => {
      const result = await openZonePainterHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    },
  }),
  defineTool({
    name: 'hayba_read_zones',
    description: 'Read the zones a user has painted, to drive placement decisions.',
    meta: {
      cost: 'low',
      effects: [],
      when: 'turning painted zones into placement rules',
      not_when: 'you want to change the heightmap - hayba_set_painter_heightmap',
    },
    schema: {
      projectId: z.string().optional().describe('Project ID to read submitted zones from.'),
      scratchSessionId: z
        .string()
        .optional()
        .describe('Scratch session ID (for standalone zone painting without a project).'),
    },
    cost: 'low',
    returns: '{zones:[{name,color,area}]}',
    handler: async (params) => {
      const result = await readZonesHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    },
  }),
  defineTool({
    name: 'hayba_set_painter_heightmap',
    description: 'Point the zone painter at the heightmap it should paint over.',
    meta: {
      cost: 'low',
      effects: ['modifies_zone_project'],
      when: 'the painter needs a terrain image to paint against',
      not_when: 'the project does not exist yet - hayba_open_zone_painter first',
    },
    schema: {
      projectId: z.string().describe('Project ID to associate the heightmap with.'),
      heightmapPath: z.string().describe('Absolute path to the baked heightmap PNG or R16 file.'),
    },
    cost: 'low',
    returns: '{ok, projectId, heightmapPath}',
    handler: async (params) => {
      const result = await setPainterHeightmapHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    },
  }),
  defineTool({
    name: 'hayba_import_landscape',
    description: 'Import a heightmap (PNG or R16) as an UE Landscape actor. Wraps the UE-side landscape_import handler. The heightmap is sampled 0..uint16-max -> 0..maxHeightM (m). Spawns one Landscape covering worldSizeKm x worldSizeKm.',
    meta: {
      cost: 'high',
      effects: ['imports_landscape', 'modifies_level'],
      when: 'you need terrain that PCG can sample points against',
      not_when: 'a static mesh is sufficient and no PCG sampling is needed',
    },
    schema: {
      heightmapPath: z.string().describe('Absolute path to a PNG or R16 heightmap file'),
      worldSizeKm: z.number().optional().default(8.0).describe('Landscape XY size in km'),
      maxHeightM: z
        .number()
        .optional()
        .default(600.0)
        .describe('Maximum height in m (0..maxHeightM mapped from uint16)'),
      actorLabel: z.string().optional().default('Hayba_Terrain').describe('Label for the spawned Landscape actor'),
      landscapeMaterial: z.string().optional().describe('UE material path; empty = no material'),
    },
    cost: 'high',
    returns: '{ok, actor, size, components}',
    handler: async (params) => {
      try {
        const data = await executeCommand('landscape_import', params as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
        };
      } catch (e) {
        return errorResult(`Error importing landscape: ${(e as Error).message}`);
      }
    },
  }),
];

const HANDWRITTEN_STANDARD_DESCRIPTORS: ToolDescriptor[] = [
  // ── World generation (always-on flagship) ────────────────────────────────
  {
    name: 'world_generate',
    description:
      'Build an environment from a natural-language biome description. Parses the prompt into layers (canopy/rock/undergrowth/groundcover), resolves one of the PROJECT\'S OWN StaticMeshes per layer, plans a deterministic seeded scatter across an area actor, then PLUMB-VALIDATES and auto-corrects every instance IN MEMORY (grounded, non-interpenetrating) before spawning — "scatter and prove", not scatter-and-hope. Use dry_run to get the validated plan without spawning.',
    meta: worldGenerateMeta,
    handler: worldGenerateHandler,
    cost: 'high',
    returns:
      '{ok, center_cm, layers:[{role,keywords,asset}], gaps:[string], planned, validation:{ran,passes,failed_before,failed_after,fixed}, ism_actors, instances, place_errors?, sample?}. Places one Instanced-Static-Mesh actor per resolved mesh with the validated transforms as instances.',
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
    description: 'Place a new actor in the active level by class — a light, a volume, a blueprint actor, or any registered UClass. To place a StaticMesh or other content asset by its path instead, use actor_spawn_from_asset.',
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
    description: 'List what is in the scene: every actor in the active level with its label, class and transform. Start here when you need to know what already exists before changing anything.',
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

  // ── Agent memory domain (issue #355) ──────────────────────────────────────
  // Wraps HaybaMemory (src/gaea/memory/hayba-memory.ts), a SQLite-backed store
  // of small text blocks an agent writes and later recalls. Was fully
  // implemented, tested only by its own excluded test, and reachable by
  // nothing — see the issue for why it is being surfaced now.
  {
    name: 'memory_write',
    description: 'Write a memory block: an intent, its content, which agent role wrote it, and whether it is private or shared with other agents. Runs bounded retention (age + count) after every write and reports what (if anything) it pruned.',
    meta: memoryWriteMeta,
    handler: memoryWriteHandler,
    cost: 'low',
    returns: '{ok, id, retention:{pruned_by_age, pruned_by_count, pruned_total, remaining}}',
    schema: {
      agentRole: z.string().min(1).describe('Role of the writing agent, e.g. "director", "asset-manager"'),
      scope: z.enum(['private', 'shared']).describe('"private" = only this agentRole sees it via recall/list filters; "shared" = any role can'),
      intent: z.string().min(1).describe('Short label for what this block is about'),
      content: z.string().min(1).describe('The memory content itself'),
      accessedResources: z.array(z.string()).optional().describe('Resource paths/ids touched while forming this memory'),
      tokenCost: z.number().optional().describe('Approximate token cost of the content, for budget tracking'),
      provenance: z.record(z.string(), z.unknown()).optional().describe('Free-form provenance, e.g. {tool, cursor}'),
      id: z.string().optional().describe('Explicit id (default: a generated UUID) — mainly for re-inserting/overwriting a known block'),
      timestamp: z.number().optional().describe('Explicit epoch-ms timestamp (default: now) — mainly for import/migration'),
    },
  },
  {
    name: 'memory_recall',
    description: 'Search memory blocks by keyword against their intent and content, most recent match first. Use when you remember roughly what a past block was about but not its id.',
    meta: memoryRecallMeta,
    handler: memoryRecallHandler,
    cost: 'low',
    returns: '{blocks:[MemoryBlock], count, query}',
    schema: {
      text: z.string().min(1).describe('Keyword/phrase to search for in intent + content'),
      scope: z.enum(['private', 'shared']).optional(),
      agentRole: z.string().optional().describe('Restrict to blocks written by this role'),
      limit: z.number().int().positive().optional().describe('Max blocks to return (default 10)'),
    },
  },
  {
    name: 'memory_list',
    description: 'List recent memory blocks for a role/scope, most-recent-first, with no keyword filter. Use to browse what has been written, not to search for something specific.',
    meta: memoryListMeta,
    handler: memoryListHandler,
    cost: 'low',
    returns: '{blocks:[MemoryBlock], count, total_matching, truncated}',
    schema: {
      scope: z.enum(['private', 'shared']).optional(),
      agentRole: z.string().optional(),
      limit: z.number().int().positive().optional().describe('Max blocks to return (default 50)'),
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete memory blocks: a single block by id, every block from one agentRole, or (with confirm_all) the entire store. Exactly one of id / agentRole / confirm_all is required.',
    meta: memoryDeleteMeta,
    handler: memoryDeleteHandler,
    cost: 'low',
    returns: '{ok, deleted_count, ...}',
    schema: {
      id: z.string().optional().describe('Delete exactly this block'),
      agentRole: z.string().optional().describe('Delete every block written by this role'),
      confirm_all: z.boolean().optional().describe('Set true to delete the entire store — required, not inferred'),
    },
  },
  {
    name: 'memory_export',
    description: 'Dump memory blocks (optionally filtered by scope/agentRole) to a portable JSON file for backup or transfer to another store via memory_import.',
    meta: memoryExportMeta,
    handler: memoryExportHandler,
    cost: 'low',
    returns: '{ok, path, count}',
    schema: {
      path: z.string().min(1).describe('File path to write the export JSON to'),
      scope: z.enum(['private', 'shared']).optional(),
      agentRole: z.string().optional(),
    },
  },
  {
    name: 'memory_import',
    description: 'Load a memory_export JSON file back into the store. Reports exactly what happened per row: inserted, skipped (malformed), or conflicted (id already existed — left alone under "skip", overwritten under "replace").',
    meta: memoryImportMeta,
    handler: memoryImportHandler,
    cost: 'low',
    returns: '{ok, total_read, inserted, skipped, conflicted, errors:[string]}',
    schema: {
      path: z.string().min(1).describe('File path previously written by memory_export'),
      on_conflict: z.enum(['skip', 'replace']).optional().describe('How to handle an id that already exists (default "skip")'),
    },
  },
  {
    name: 'memory_prune',
    description: 'Force retention to run now with an explicit (or default-configured) age/count bound. memory_write already does this automatically after every insert — use this only to prune on demand with a tighter one-off bound.',
    meta: memoryPruneMeta,
    handler: memoryPruneHandler,
    cost: 'low',
    returns: '{ok, pruned_by_age, pruned_by_count, pruned_total, remaining}',
    schema: {
      max_count: z.number().int().positive().optional().describe('Keep at most this many blocks (default: configured HAYBA_MEMORY_MAX_COUNT)'),
      max_age_days: z.number().positive().optional().describe('Delete blocks older than this many days (default: configured HAYBA_MEMORY_MAX_AGE_DAYS)'),
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
      value: z
        .union([
          z.number().describe('Scalar value'),
          z.array(z.number()).min(1).max(4).describe('Vector value (1-4 components for rgba)'),
          z.string().describe('Texture asset path'),
        ])
        .describe('Parameter value: scalar, vector (1-4 elements), or texture asset path'),
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
    description:
      'Inspect a material, material function, or material instance: properties, parameters, and the full expression graph. For materials/functions, each expression input includes its source edge (from_node + from_output), each node reports output_consumed + reachable_from_output, and a top-level dead_nodes[] lists every node NOT reachable from any material output — i.e. provably dead, safe to delete (no delete-recompile-compare needed).',
    meta: materialGetInfoMeta,
    handler: materialGetInfoHandler,
    cost: 'low',
    returns:
      "{kind, name, expressions:[{id,class,x,y,output_consumed,reachable_from_output,reroute_name?,reroute_kind?,inputs:[{name,index,connected,from_node,from_output}],outputs:[{name,index}]}], dead_nodes:[{id,class}], comments} | instance:{kind,name,parent,parameters:[{name,type,value}]}. Named-reroute nodes report reroute_name + reroute_kind('declaration'|'usage') so you can bind a usage to a declaration WITHOUT scanning expressions in python. outputs[] gives a node's real output pin order (esp. MaterialFunctionCall, whose order follows FunctionOutput sort priority, NOT the visual layout) — wire from_output by these.",
    niche: M,
    schema: {
      path: z.string().min(1).describe('Path to the material or material instance to inspect'),
    },
  },

  // ── Material graph-layer domain ───────────────────────────────────────────
  {
    name: 'material_add_node',
    description:
      "Add a new expression node to a material graph. For a MaterialFunctionCall, pass properties.function (asset path) — the node's inputs/outputs are rebuilt immediately (UpdateFromFunctionResource), so its output pins are wirable right away and are returned in outputs[]. No recompile/refresh dance needed.",
    meta: materialAddNodeMeta,
    handler: materialAddNodeHandler,
    cost: 'low',
    returns:
      '{node_id, outputs?:[{name,index}]}  — outputs[] present for MaterialFunctionCall nodes (the pin names to use as from_output)',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
      expression_class: z
        .string()
        .min(1)
        .describe('UE expression class name, e.g. "MaterialExpressionVectorParameter"'),
      node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y] for the new node'),
      properties: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Initial properties for the node. For a MaterialFunctionCall set "function" (or "function_path") to the function asset path — outputs are rebuilt immediately and returned.',
        ),
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
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
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
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
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
      properties: z
        .record(z.string(), z.unknown())
        .describe(
          'Settings; aliases: domain, blend_mode, shading_model, two_sided, opacity_mask_clip_value, enable_tessellation',
        ),
    },
  },
  {
    name: 'material_compile',
    description:
      'Finalize a material OR material FUNCTION: write it to disk, apply staged settings, surface translator errors + shader optimization stats (materials). Graph edits DEFER the disk write — call this once the graph is complete. NOTE: material functions no longer auto-save either, so after editing a function call material_compile with function_path to persist it (this avoids a half-built function crashing the editor when it is opened/compiled).',
    meta: materialCompileMeta,
    handler: materialCompileHandler,
    cost: 'medium',
    returns:
      '{errors:[string], has_errors, saved, stats:{shaders:[{name,instructions}], texture_samples, ...}} (materials) | {saved} (functions)',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the master material asset to compile (either this or function_path)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to a material FUNCTION to finalize + save (either this or material_path)'),
    },
  },
  {
    name: 'material_validate',
    description:
      'Statically check a material OR material FUNCTION graph for translator-crash-prone wiring WITHOUT compiling: reroutes/named-reroutes used downstream that resolve to no input, and connections to non-existent output indices — both trigger an uncatchable HLSL-translator assert that kills the editor. material_compile runs these same checks and refuses to compile when any fail, so call this first to fix issues safely.',
    meta: materialValidateMeta,
    handler: materialValidateHandler,
    cost: 'low',
    returns: '{ok:boolean, problems:[string]}',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the master material to validate (either this or function_path)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to a material FUNCTION to validate (either this or material_path)'),
    },
  },
  {
    name: 'texture_get_info',
    description:
      'Inspect a Texture2D: dimensions, source/platform format, mip count, compression settings, LOD group, sRGB, never-stream, address modes.',
    meta: textureGetInfoMeta,
    handler: textureGetInfoHandler,
    cost: 'low',
    returns:
      '{path, width, height, format, num_mips, compression_settings, lod_group, srgb, never_stream, address_x, address_y}',
    schema: {
      path: z.string().min(1).describe('Texture asset path, e.g. /Game/Tex/T_Rock'),
    },
  },
  {
    name: 'texture_set_compression',
    description:
      "Set a texture's compression (TC_*) and optionally LOD group + sRGB. Re-imports the texture resource. For other properties (mip gen, max size, filter, address, ...) use texture_set_settings.",
    meta: textureSetCompressionMeta,
    handler: textureSetCompressionHandler,
    cost: 'low',
    returns: '{ok, path, compression_settings, lod_group, srgb}',
    schema: {
      path: z.string().min(1).describe('Texture asset path'),
      compression_settings: z
        .string()
        .min(1)
        .describe('TextureCompressionSettings, e.g. Normalmap / Masks / Default (TC_ prefix optional)'),
      lod_group: z
        .string()
        .optional()
        .describe('TextureGroup, e.g. World / WorldNormalMap (TEXTUREGROUP_ prefix optional)'),
      srgb: z.boolean().optional().describe('sRGB flag'),
    },
  },
  {
    name: 'texture_set_settings',
    description:
      'Set any texture properties at once via reflection. Aliases: compression_settings, lod_group, srgb, never_stream, address_x, address_y, mip_gen_settings, max_texture_size, flip_green_channel, filter, virtual_texture_streaming, lod_bias. Any raw UTexture UPROPERTY name also works. Re-imports the resource after applying.',
    meta: textureSetSettingsMeta,
    handler: textureSetSettingsHandler,
    cost: 'low',
    returns: '{ok, path, applied:[string], compression_settings, lod_group, srgb, never_stream}',
    schema: {
      path: z.string().min(1).describe('Texture asset path'),
      properties: z
        .record(z.string(), z.unknown())
        .describe(
          'Settings to set, e.g. { compression_settings: "Normalmap", srgb: false, mip_gen_settings: "Sharpen4" }',
        ),
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
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
      text: z.string().describe('Comment title/text shown on the box'),
      node_pos: z.tuple([z.number(), z.number()]).optional().describe('Top-left graph position [x, y]'),
      size: z.tuple([z.number(), z.number()]).optional().describe('Box size [width, height]'),
      color: z.array(z.number()).min(3).max(4).optional().describe('Box color [r, g, b] or [r, g, b, a] (0..1)'),
      font_size: z.number().int().optional().describe('Title font size (default 18)'),
    },
  },
  {
    name: 'material_delete_comment',
    description:
      'Delete a comment box from a material or function graph (comment_id from material_get_info.comments[].id). Named reroutes are nodes — use material_delete_node for those.',
    meta: materialDeleteCommentMeta,
    handler: materialDeleteCommentHandler,
    cost: 'low',
    returns: '{deleted}',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
      comment_id: z.string().min(1).describe('Comment id to delete (from material_get_info.comments[].id)'),
    },
  },
  {
    name: 'material_set_comment',
    description:
      'Edit an existing comment box (move/resize/retitle/recolor) by id — only the fields you pass change. Completes comment CRUD so comments never need a Python fallback.',
    meta: materialSetCommentMeta,
    handler: materialSetCommentHandler,
    cost: 'low',
    returns: '{comment_id}',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
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
    description:
      'Create a named-reroute declaration (source anchor) so a value can be referenced by name instead of long wires.',
    meta: materialAddRerouteDeclarationMeta,
    handler: materialAddRerouteDeclarationHandler,
    cost: 'low',
    returns: '{node_id}',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
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
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
      declaration_id: z.string().min(1).describe('node_id of the reroute declaration to bind to'),
      node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y]'),
    },
  },
  {
    name: 'asset_delete',
    description:
      'Permanently delete content assets, verifying on the FILESYSTEM that each file is gone. Pass `paths` to delete a set in one call. READ deleted_count, not requested — it counts .uasset files actually removed. NEVER verify a delete with does_asset_exist or asset_search: the asset registry can report an asset gone while its file is still on disk, and that is exactly how a batch delete reports success for files it never removed. Assets the registry has lost but whose files remain are reported as ORPHANED and must be removed from disk directly.',
    meta: assetDeleteMeta,
    handler: assetDeleteHandler,
    cost: 'low',
    returns:
      '{requested, deleted_count, still_on_disk_count, warning?, results:[{path, existed_on_disk, existed_in_registry, engine_reported_deleted, file_gone, deleted, file, reason?}]}',
    schema: {
      path: z.string().optional().describe('Object path of one asset to delete, e.g. /Game/Foo/MF_X.MF_X'),
      paths: z
        .array(z.string().min(1))
        .optional()
        .describe('Several assets in one call. Prefer this over looping — one call reports which ones actually went.'),
    },
  },
  {
    name: 'material_connect_nodes',
    description:
      'Connect two nodes in a material graph or connect a node output to a material property. IMPORTANT for multi-output sources (esp. MaterialFunctionCall): you MUST pick the output pin with from_output (the pin NAME) or from_output_index — otherwise the call is rejected, because defaulting to the first output silently swaps function outputs (e.g. Albedo<->F0). Get the real pin names/order from material_get_info.expressions[].outputs[]. May return clutter-prevention suggestions: use named reroutes when a source fans out to 2+ targets, or a reroute knee node when a wire would run backward/over another node.',
    meta: materialConnectNodesMeta,
    handler: materialConnectNodesHandler,
    cost: 'low',
    returns: '{connected, from_node_fanout?, suggestions?[]}',
    niche: M,
    schema: {
      material_path: z
        .string()
        .optional()
        .describe('Path to the material asset (either this or function_path required)'),
      function_path: z
        .string()
        .optional()
        .describe('Path to the material function asset (either this or material_path required)'),
      from_node: z.string().min(1).describe('ID or name of the source node'),
      from_output: z
        .string()
        .optional()
        .describe(
          'Output pin NAME on the source node (from material_get_info.expressions[].outputs[].name). REQUIRED when the source has >1 output (e.g. a material function) unless you pass from_output_index.',
        ),
      to_node: z.string().optional().describe('ID or name of the target node'),
      to_input: z.string().optional().describe('Input pin name on the target node'),
      to_input_index: z
        .number()
        .int()
        .optional()
        .describe('Target input pin by index (unnamed pins, e.g. Substrate slab inputs)'),
      from_output_index: z.number().int().optional().describe('Source output pin by index (default 0)'),
      to_property: z
        .string()
        .optional()
        .describe(
          'Target material output, e.g. base_color, normal, front_material (Substrate), displacement (Nanite tessellation - needs material_set_property enable_tessellation=true)',
        ),
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
      to_input_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Zero-based input pin index (alternative to to_input)'),
      to_property: z
        .string()
        .optional()
        .describe('Material output property name to disconnect (e.g. base_color, normal)'),
    },
  },

  // ── UMG / Widget Blueprint domain ─────────────────────────────────────────
  // Native TS wrappers over the modern FHaybaMCPUIHandler (GetDomain()=="ui").
  // Param names mirror HaybaMCPUIHandler.cpp exactly (the source of truth):
  // ui_add_element takes slot_props (not "properties"); ui_query takes path
  // (not widget_blueprint_path).
  // Property editing tools compose down to ui_set_widget_properties.
  // Structural tools compose down to ui_mutate_tree.
  {
    name: 'ui_create_widget',
    description:
      'CREATE A NEW MENU, SCREEN OR HUD as a UMG Widget Blueprint asset — the designer-editable kind an artist can also open. Seeds a root CanvasPanel ready for content. USE_WHEN: starting any new piece of UI. NOT_WHEN: adding to an existing one (ui_add_element / ui_build_tree), or inspecting what a running game is showing (editor_pie_widget_tree).',
    meta: uiCreateWidgetMeta,
    handler: uiCreateWidgetHandler,
    cost: 'medium',
    returns: '{path, name, parent_class, root?}',
    niche: UI,
    schema: {
      path: z.string().min(1).describe('UE content package directory, e.g. "/Game/Aphrosia/UI"'),
      name: z.string().min(1).describe('Asset name, e.g. "WBP_StartScreen"'),
      parent_class: z
        .string()
        .optional()
        .describe('Parent class (must descend from UserWidget); class path or short name. Defaults to UserWidget.'),
    },
  },
  {
    name: 'ui_add_element',
    description:
      'Add a widget (Button/TextBlock/Image/panel/…) to an existing Widget Blueprint tree, optionally under a named panel, with slot layout props. Marks the BP structurally modified + dirty.',
    meta: uiAddElementMeta,
    handler: uiAddElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, parent, name, class, slot_class}',
    niche: UI,
    schema: {
      widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
      child_class: z
        .string()
        .min(1)
        .describe('Widget class — short name (Button, TextBlock, CanvasPanel, HorizontalBox, …) or full class path'),
      parent_widget_name: z
        .string()
        .optional()
        .describe('Name of an existing PANEL widget to parent under; defaults to the root panel'),
      name: z.string().optional().describe('Name for the new widget (auto-generated if omitted)'),
      slot_props: z
        .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
        .optional()
        .describe('Slot layout props: x/y/w/h (canvas), fill/padding (box); other keys set on the slot by reflection'),
    },
  },
  {
    name: 'ui_query',
    description:
      'Return the widget tree of a Widget Blueprint - per-widget name, class, slot, variable GUID and typed properties. Pass name_pattern / class_filter / flatten to get a flat list of matching widgets instead of the whole tree.',
    meta: uiQueryMeta,
    handler: uiQueryHandler,
    cost: 'low',
    returns: '{path, parent_class, root:{name, class, slot, guid?, properties?, children:[…]}}',
    niche: UI,
    schema: uiQuerySchema.shape,
  },
  {
    name: 'ui_set_widget_properties',
    description:
      'Generic tool: set named properties and/or slot layout on a designer widget. Operates on the authoritative WidgetTree (not the generated template). Property values may be nested objects for struct properties (Brush, Font). Reports per-key outcomes: succeeded, failed_properties, unknown_slot_props. NOT transacted - these edits deliberately stay out of the editor undo stack, because the transaction buffer can pin PIE references and crash the editor. Prefer the typed tools (ui_set_property, ui_set_text_style, ui_set_slot_layout) for common operations.',
    meta: uiSetWidgetPropertiesMeta,
    handler: uiSetWidgetPropertiesHandler,
    cost: 'medium',
    returns: '{succeeded, failed, failed_properties?}',
    niche: UI,
    schema: uiSetWidgetPropertiesSchema.shape,
  },
  {
    name: 'ui_set_property',
    description:
      'Set a single arbitrary property on a designer widget by name and value. Typed wrapper around ui_set_widget_properties for the common case of changing one thing.',
    meta: uiSetPropertyMeta,
    handler: uiSetPropertyHandler,
    cost: 'low',
    returns: '{succeeded, failed, failed_properties?}',
    niche: UI,
    schema: uiSetPropertySchema.shape,
  },
  {
    name: 'ui_set_text_style',
    description:
      'Set text styling on a TextBlock widget in a Widget Blueprint: font, typeface, size, letter spacing, color, outline, shadow, justification. All values survive compile+save+restart.',
    meta: uiSetTextStyleMeta,
    handler: uiSetTextStyleHandler,
    cost: 'low',
    returns: '{succeeded, failed}',
    niche: UI,
    schema: uiSetTextStyleSchema.shape,
  },
  {
    name: 'ui_set_brush',
    description:
      'Set the brush on an Image or Border widget in a Widget Blueprint: texture/material resource, tint color, draw style, image size, and 9-slice margins.',
    meta: uiSetBrushMeta,
    handler: uiSetBrushHandler,
    cost: 'low',
    returns: '{succeeded, failed}',
    niche: UI,
    schema: uiSetBrushSchema.shape,
  },
  {
    name: 'ui_set_visibility',
    description:
      'Set the visibility of a designer widget in a Widget Blueprint. Changes survive compile, save, and editor restart.',
    meta: uiSetVisibilityMeta,
    handler: uiSetVisibilityHandler,
    cost: 'low',
    returns: '{succeeded, failed}',
    niche: UI,
    schema: uiSetVisibilitySchema.shape,
  },
  {
    name: 'ui_set_slot_layout',
    description:
      'Set CanvasPanel slot layout on a designer widget: anchors (as `anchors` [minX,minY,maxX,maxY], or `anchors_min`+`anchors_max` [x,y] pairs), `position`, `size`, `alignment`, `z_order`, `auto_size`; box/grid slots take `padding`, `fill`, alignments, row/column. Anchors + position + alignment are committed to the CanvasPanelSlot atomically (one LayoutData write). Unknown parameter names are REJECTED with a validation error rather than silently dropped. For non-Canvas slots use the slot_props field in ui_set_widget_properties.',
    meta: uiSetSlotLayoutMeta,
    handler: uiSetSlotLayoutHandler,
    cost: 'low',
    returns: '{succeeded, failed}',
    niche: UI,
    schema: uiSetSlotLayoutSchema.shape,
  },
  {
    name: 'ui_compile_widget',
    description:
      'Compile a Widget Blueprint asset. Returns compilation status (UpToDate/Error/Dirty), warnings, and errors. Optionally save on successful compilation.',
    meta: uiCompileWidgetMeta,
    handler: uiCompileWidgetHandler,
    cost: 'high',
    returns: '{success, status, warnings, errors}',
    niche: UI,
    schema: uiCompileWidgetSchema.shape,
  },
  {
    name: 'ui_save_widget',
    description:
      'Save a Widget Blueprint package to disk. Optionally compile before save. Returns whether the save succeeded and whether the package is still dirty.',
    meta: uiSaveWidgetMeta,
    handler: uiSaveWidgetHandler,
    cost: 'medium',
    returns: '{saved_path, success, package_dirty_after_save}',
    niche: UI,
    schema: uiSaveWidgetSchema.shape,
  },
  {
    name: 'ui_get_widget_info',
    description:
      'Get detailed info about a Widget Blueprint: full widget tree with properties, variable GUIDs, slot layout, and typed property values per widget.',
    meta: uiGetWidgetInfoMeta,
    handler: uiGetWidgetInfoHandler,
    cost: 'low',
    returns: '{path, parent_class, root:{name, class, guid?, properties?, slot?, children:[…]}}',
    niche: UI,
    schema: uiGetWidgetInfoSchema.shape,
  },
  {
    name: 'ui_search_widgets',
    description:
      'Search within a Widget Blueprint for widgets matching a name pattern or class filter. Returns matching widget paths and properties.',
    meta: uiSearchWidgetsMeta,
    handler: uiSearchWidgetsHandler,
    cost: 'low',
    returns: '{results:[{path, name, class, properties?}]}',
    niche: UI,
    schema: uiSearchWidgetsSchema.shape,
  },
  {
    name: 'ui_list_widget_types',
    description:
      'List UMG widget classes that can be added via ui_add_element or ui_replace_element. Native classes by default; pass include_blueprints to also list your own Widget Blueprint classes, or panels_only to narrow to containers.',
    meta: uiListWidgetTypesMeta,
    handler: uiListWidgetTypesHandler,
    cost: 'low',
    returns: '{types:[{name, class_path, is_panel, is_native, description}]}',
    niche: UI,
    schema: uiListWidgetTypesSchema.shape,
  },
  {
    name: 'ui_remove_element',
    description:
      'Remove a widget from a Widget Blueprint designer tree, together with its whole subtree. Variable GUIDs for every removed descendant are purged, not just the named widget. Removing the root requires an explicit replacement_root.',
    meta: uiRemoveElementMeta,
    handler: uiRemoveElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, operation, widget_name, old_parent, old_child_index?}',
    niche: UI,
    schema: uiRemoveElementSchema.shape,
  },
  {
    name: 'ui_reparent_element',
    description:
      'Move an existing designer widget from its current parent to a new parent panel. Preserves widget instance and GUID. Creates the correct slot class for the new parent.',
    meta: uiReparentElementMeta,
    handler: uiReparentElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, operation, widget_name, old_parent, old_child_index, new_parent, new_child_index, new_slot_class, unknown_slot_props?}',
    niche: UI,
    schema: uiReparentElementSchema.shape,
  },
  {
    name: 'ui_replace_element',
    description:
      'Replace a designer widget with a different class at the same position. Preserves parent, child index and slot layout; optionally the name, the variable GUID (preserve_guid) and every property the two classes share by name and type (preserve_properties).',
    meta: uiReplaceElementMeta,
    handler: uiReplaceElementHandler,
    cost: 'medium',
    returns:
      '{widget_blueprint_path, operation, widget_name, old_class, new_class, new_name, child_index, properties_copied}',
    niche: UI,
    schema: uiReplaceElementSchema.shape,
  },

  {
    name: 'ui_build_tree',
    description:
      'Build a whole widget subtree from one nested spec - {class, name?, properties?, slot_props?, children?}. One call instead of one ui_add_element per widget. Depth-first in order; on failure the widgets already created are KEPT and named in the error so you can see exactly how far it got.',
    meta: uiBuildTreeMeta,
    handler: uiBuildTreeHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, parent, created, names[], warnings?[], error?, partial?}',
    niche: UI,
    schema: uiBuildTreeSchema.shape,
  },
  {
    name: 'ui_duplicate_element',
    description:
      'Duplicate a widget and its entire subtree, cloning properties and slot layout. The copy and every duplicated descendant are registered as designer variables. Use for repeated rows, cards and list entries.',
    meta: uiDuplicateElementMeta,
    handler: uiDuplicateElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, operation, source, name, parent, widgets_duplicated}',
    niche: UI,
    schema: uiDuplicateElementSchema.shape,
  },
  {
    name: 'ui_move_element',
    description:
      'Reorder a widget among its siblings. Child order is draw order and tab order in box panels. Slot layout is preserved across the move; an out-of-range index is rejected with the valid range.',
    meta: uiMoveElementMeta,
    handler: uiMoveElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, operation, widget_name, parent, old_index, new_index}',
    niche: UI,
    schema: uiMoveElementSchema.shape,
  },
  {
    name: 'ui_rename_element',
    description:
      'Rename a designer widget, carrying its variable GUID across so existing bindings keep resolving. The widget name IS the variable name the graph and C++ BindWidget use, so this is an API change.',
    meta: uiRenameElementMeta,
    handler: uiRenameElementHandler,
    cost: 'medium',
    returns: '{widget_blueprint_path, operation, old_name, new_name, guid_preserved}',
    niche: UI,
    schema: uiRenameElementSchema.shape,
  },
  {
    name: 'ui_set_variable',
    description:
      'Expose (or hide) a widget as a blueprint variable - the designer Is Variable checkbox. Without it the graph and C++ BindWidget cannot reach the widget at all.',
    meta: uiSetVariableMeta,
    handler: uiSetVariableHandler,
    cost: 'low',
    returns: '{widget_name, is_variable, category?}',
    niche: UI,
    schema: uiSetVariableSchema.shape,
  },
  {
    name: 'ui_bind_property',
    description:
      'Bind a widget property (Text, ToolTipText, Visibility, bIsEnabled) to a blueprint variable - the designer Bind dropdown. This is how a reusable pure-Blueprint component gets a settable caption without a C++ base class. Omit variable_name to clear the binding.',
    meta: uiBindPropertyMeta,
    handler: uiBindPropertyHandler,
    cost: 'low',
    returns: '{widget_name, property_name, variable_name?, bound, binding_count?}',
    niche: UI,
    schema: uiBindPropertySchema.shape,
  },
  {
    name: 'ui_list_widget_blueprints',
    description:
      'List the Widget Blueprints that exist in the project, with the _C class path needed to use one as a child widget or as a parent class. Reads the asset registry, so no blueprint is loaded.',
    meta: uiListWidgetBlueprintsMeta,
    handler: uiListWidgetBlueprintsHandler,
    cost: 'low',
    returns: '{widget_blueprints:[{name, path, package, parent_class?, class_path}], count}',
    niche: UI,
    schema: uiListWidgetBlueprintsSchema.shape,
  },
  {
    name: 'ui_layout_snapshot',
    description:
      'Resolve the real on-screen geometry of every widget by running a Slate prepass on the compiled widget class, plus per-widget font, measured text width and brush facts. This is the measurement layer ui_validate judges. layout_resolved:false means the blueprint could not be instantiated (usually: compile it first) and geometry is absent rather than zero.',
    meta: uiLayoutSnapshotMeta,
    handler: uiLayoutSnapshotHandler,
    cost: 'medium',
    returns:
      '{widget_blueprint_path, screen_width, screen_height, layout_resolved, layout_error?, widget_count, widgets:[{name, class, x, y, width, height, depth, anchors?, text_info?, brush_info?}]}',
    niche: UI,
    schema: uiLayoutSnapshotSchema.shape,
  },
  {
    name: 'ui_copy_style',
    description:
      '"Make this look like that one" — copies a working widget\'s brush (draw_as, resource, margin, tint, size) and text style (font, typeface, size, colour) onto another. Copies STYLE ONLY: slot layout and text content stay the target\'s, so matching a look cannot wreck a layout. Use dry_run to see what would be copied. USE_WHEN: one widget already looks right. NOT_WHEN: you know the values (ui_set_brush / ui_set_text_style) or want the widget itself (ui_duplicate_element).',
    meta: uiCopyStyleMeta,
    handler: uiCopyStyleHandler,
    cost: 'high',
    returns: '{from, to, widget_blueprint_path, copied[], copied_count, applied:[{aspect, values}], failed[], note}',
    niche: UI,
    schema: uiCopyStyleSchema.shape,
  },
  {
    name: 'editor_save_all_and_quit',
    description:
      'Save every unsaved package, then shut the editor down — in that order. Shutting down with a dirty asset parks the editor on a modal save prompt that nothing can answer, because the MCP port closes first; three editor deaths in one session each cost exactly the assets still unsaved. REFUSES to quit if anything is still dirty after the save pass, and names what is holding it up. Pass quit:false to save everything without shutting down. USE_WHEN: ending a session, or closing the editor to link C++. NOT_WHEN: you only want to save (asset_save).',
    meta: editorSaveAllAndQuitMeta,
    handler: editorSaveAllAndQuitHandler,
    cost: 'high',
    returns: '{quit, saved[], saved_count, still_dirty[]?, note?}',
    niche: 'editor',
    schema: editorSaveAllAndQuitSchema.shape,
  },
  {
    name: 'ui_set_default_font',
    description:
      'Rewrite every text widget still on an engine default font (Roboto) onto a project font, in one call. New TextBlocks always arrive as /Engine/EngineFonts/Roboto "Bold" and ui_set_text_style only changes the fields you pass — so setting size and colour but forgetting font_asset+typeface silently keeps Roboto and still reports success. Use dry_run first to see what would change. USE_WHEN: a blueprint has the default font anywhere. NOT_WHEN: restyling one widget (ui_set_text_style).',
    meta: uiSetDefaultFontMeta,
    handler: uiSetDefaultFontHandler,
    cost: 'high',
    returns: '{widget_blueprint_path, font_asset, typeface, changed:[{widget, from}], changed_count, failed:[{widget, error}], failed_count, note}',
    niche: UI,
    schema: uiSetDefaultFontSchema.shape,
  },
  {
    name: 'ui_render_widget_to_png',
    description:
      'SEE a Widget Blueprint: draws it to a PNG and returns the image inline, with no PIE session and no editor restart. This is how you check fonts, colours, brushes, spacing and overflow in seconds instead of a rebuild-and-play cycle. Read coverage_percent — 0 means the widget drew nothing and the PNG is blank. USE_WHEN: you want to look at the UI. NOT_WHEN: you want numbers (ui_layout_snapshot) or a verdict (ui_validate).',
    meta: uiRenderWidgetToPngMeta,
    handler: uiRenderWidgetToPngHandler,
    cost: 'high',
    returns:
      '{widget_blueprint_path, out_path, width, height, design_width, design_height, bytes, opaque_background, coverage_percent, warning?, inline_image_skipped?} + the PNG as an image block',
    niche: UI,
    schema: uiRenderWidgetToPngSchema.shape,
  },
  {
    name: 'ui_measure_text',
    description:
      'Measure a string exactly, through the Slate font measure service, in a widget real font or an explicit one. Returns rendered width/height plus how many characters fit in the box: the actual string, typical mixed-case prose, and the worst case if every glyph were the font widest. Use this to size a label for variable-length runtime text (player names, item names, translations) BEFORE it clips in game.',
    meta: uiMeasureTextMeta,
    handler: uiMeasureTextHandler,
    cost: 'low',
    returns:
      '{text, width_px, height_px, available_width_px, overflows, chars_that_fit, typical_chars_that_fit, worst_case_chars_that_fit, font_size, font_object?}',
    niche: UI,
    schema: uiMeasureTextSchema.shape,
  },
  {
    name: 'ui_validate',
    description:
      'CHECK A SCREEN AGAINST GAME-UI STANDARDS: runs the UI rule catalogue over a real Slate layout and reports precise, actionable findings - text that overflows (and the exact character count at which it does), labels with no room for translation growth, content inside TV title/action-safe margins, touch targets below the platform minimum, overlapping siblings, contrast below WCAG, controls gamepad focus cannot reach, and performance traps. Judged per platform (pc/console/handheld/mobile) and per strictness (relaxed/standard/strict). USE_WHEN: after building or editing a Widget Blueprint, and before calling the screen done. NOT_WHEN: you only need the tree (ui_query) or one measurement (ui_measure_text). Rules that need geometry are reported as SKIPPED when the layout cannot be resolved - never as passing.',
    meta: uiValidateMeta,
    handler: uiValidateHandler,
    cost: 'medium',
    returns:
      '{widget_blueprint_path, platform, strictness, layout_resolved, findings:[{ruleId, severity, widget?, message, hint, data}], rules_evaluated, rules_skipped_no_layout[], rules_disabled[], rules_below_strictness[], counts}',
    niche: UI,
    schema: uiValidateSchema.shape,
  },

  // ── Docs domain ───────────────────────────────────────────────────────────
  // Reflection over the LIVE editor, so answers match the engine version and
  // plugin set actually loaded — not a web page for some other build. The C++
  // handler existed and worked; it simply had no wrapper, so the catalogue
  // reported the whole domain as unavailable.
  {
    name: 'docs_search',
    description:
      'FIND THE REAL NAME OF A UE CLASS instead of guessing. Substring search over every class loaded in the running editor. USE_WHEN: you are about to write a class name from memory. NOT_WHEN: you already have the exact path.',
    meta: docsSearchMeta,
    handler: docsSearchHandler,
    cost: 'low',
    returns: '{results:[{name, path, kind}], count, capped}',
    niche: DOCS,
    schema: docsSearchSchema.shape,
  },
  {
    name: 'docs_lookup_class',
    description:
      'Inspect a UE class in the running editor: full inheritance chain, class flags, and how many properties and functions it has. USE_WHEN: confirming a class exists and what it derives from before using it as a parent or a cast target.',
    meta: docsLookupClassMeta,
    handler: docsLookupClassHandler,
    cost: 'low',
    returns: '{name, path, parent_chain[], flags[], property_count, function_count}',
    niche: DOCS,
    schema: docsLookupClassSchema.shape,
  },
  {
    name: 'docs_lookup_api',
    description:
      'CHECK A PROPERTY OR FUNCTION EXISTS BEFORE YOU USE IT. Lists the real properties of a class (name, C++ type, category, tooltip, whether it is editable and blueprint-visible) and functions (blueprint-callable, event). USE_WHEN: before setting a property by name or calling a function — a wrong name is otherwise a silent no-op or a failed edit. Pass include_inherited when a member you expected is missing; it is usually declared on a parent.',
    meta: docsLookupApiMeta,
    handler: docsLookupApiHandler,
    cost: 'low',
    returns: '{name, properties:[{name, type, category, tooltip, is_editable, is_blueprint_visible}], functions:[{name, is_blueprint_callable, is_event, tooltip}]}',
    niche: DOCS,
    schema: docsLookupApiSchema.shape,
  },

  // ── Asset graph ───────────────────────────────────────────────────────────
  // Know what breaks before breaking it. These handlers were implemented in C++
  // and had no wrapper, so an agent could delete or rename an asset but could
  // not first ask what depended on it.
  {
    name: 'asset_get_referencers',
    description:
      'WHAT BREAKS IF I DELETE OR RENAME THIS? Lists every asset that references the given one. USE_WHEN: before asset_delete, asset_rename or asset_move — a reference you did not know about becomes a broken link that surfaces much later. NOT_WHEN: you want what the asset itself needs (asset_get_dependencies).',
    meta: assetGetReferencersMeta,
    handler: assetGetReferencersHandler,
    cost: 'low',
    returns: '{path, referencers[], count}',
    niche: ASSETGRAPH,
    schema: assetGetReferencersSchema.shape,
  },
  {
    name: 'asset_get_dependencies',
    description:
      'What this asset pulls in — everything that must exist for it to load. USE_WHEN: working out why an asset drags in a large cook, or what to migrate alongside it. NOT_WHEN: you want what depends on IT (asset_get_referencers).',
    meta: assetGetDependenciesMeta,
    handler: assetGetDependenciesHandler,
    cost: 'low',
    returns: '{path, dependencies[], count}',
    niche: ASSETGRAPH,
    schema: assetGetDependenciesSchema.shape,
  },
  {
    name: 'asset_get_references',
    description:
      'Both directions of an asset reference graph in one call. Note the lists may be truncated — `capped: true` says so. Prefer the single-direction tools when you need an exact count.',
    meta: assetGetReferencesMeta,
    handler: assetGetReferencesHandler,
    cost: 'low',
    returns: '{referencers[], dependencies[], capped}',
    niche: ASSETGRAPH,
    schema: assetGetReferencesSchema.shape,
  },
  {
    name: 'asset_rename',
    description:
      'Rename an asset in place, fixing up references rather than breaking them. Leaves a redirector behind; asset_fix_redirectors cleans those up. USE_WHEN: the name is wrong. NOT_WHEN: it belongs in another folder (asset_move).',
    meta: assetRenameMeta,
    handler: assetRenameHandler,
    cost: 'medium',
    returns: '{old_path, new_path}',
    niche: ASSETGRAPH,
    schema: assetRenameSchema.shape,
  },
  {
    name: 'asset_move',
    description:
      'Move an asset to another folder, keeping references working. Leaves a redirector behind; asset_fix_redirectors cleans those up.',
    meta: assetMoveMeta,
    handler: assetMoveHandler,
    cost: 'medium',
    returns: '{ok, old_path, new_path}',
    niche: ASSETGRAPH,
    schema: assetMoveSchema.shape,
  },
  {
    name: 'asset_fix_redirectors',
    description:
      'Collapse the redirector stubs left behind by renames and moves. USE_WHEN: after a batch of asset_rename / asset_move calls — redirectors that survive into a cook are wasted work and confuse later reference lookups.',
    meta: assetFixRedirectorsMeta,
    handler: assetFixRedirectorsHandler,
    cost: 'medium',
    returns: '{fixed_count, path}',
    niche: ASSETGRAPH,
    schema: assetFixRedirectorsSchema.shape,
  },
  {
    name: 'asset_validate',
    description:
      'Run the editor data-validation rules over an asset or folder and return the errors and warnings. USE_WHEN: confirming an asset is sound before building on it. NOT_WHEN: checking UI layout — ui_validate is the tool for that.',
    meta: assetValidateMeta,
    handler: assetValidateHandler,
    cost: 'medium',
    returns: '{valid, num_valid, num_invalid, num_warnings, errors[], warnings[]}',
    niche: ASSETGRAPH,
    schema: assetValidateSchema.shape,
  },

  // ── Foliage ───────────────────────────────────────────────────────────────
  // Implemented in C++ all along. These were briefly on a stub denylist because
  // a heuristic sweep misjudged them — a reminder that suppressing working
  // capability is as wrong as advertising broken capability.
  {
    name: 'foliage_list_types',
    description:
      'List the FoliageType assets in use in the current level, with instance counts. USE_WHEN: before adding or removing foliage, to learn what is already there.',
    meta: foliageListTypesMeta,
    handler: foliageListTypesHandler,
    cost: 'low',
    returns: '{path, count, types[]}',
    niche: FOLIAGE,
    schema: foliageListTypesSchema.shape,
  },
  {
    name: 'foliage_add_instance',
    description:
      'Place one foliage instance at an exact transform. USE_WHEN: precise single placement. NOT_WHEN: covering an area — foliage_paint_at scatters at a density instead.',
    meta: foliageAddInstanceMeta,
    handler: foliageAddInstanceHandler,
    cost: 'medium',
    returns: '{ok}',
    niche: FOLIAGE,
    schema: foliageAddInstanceSchema.shape,
  },
  {
    name: 'foliage_paint_at',
    description:
      'Scatter foliage over a circular area at a density, as the foliage paint brush does. USE_WHEN: dressing terrain. NOT_WHEN: you need one instance at an exact spot.',
    meta: foliagePaintAtMeta,
    handler: foliagePaintAtHandler,
    cost: 'medium',
    returns: '{ok}',
    niche: FOLIAGE,
    schema: foliagePaintAtSchema.shape,
  },
  {
    name: 'foliage_remove_instances',
    description:
      'Remove foliage instances of a type inside a world-space box. Returns how many were removed, so an unexpected zero is visible rather than silent.',
    meta: foliageRemoveInstancesMeta,
    handler: foliageRemoveInstancesHandler,
    cost: 'medium',
    returns: '{removed}',
    niche: FOLIAGE,
    schema: foliageRemoveInstancesSchema.shape,
  },

  // ── PIE interaction ───────────────────────────────────────────────────────
  //
  // Driving a running game. Every one of these dispatches input and returns
  // immediately — none of them block or pump the engine. The previous versions
  // spun the core ticker from inside a game-thread handler, which tore down the
  // objects they were holding and crashed the editor.
  //
  // Consequence worth knowing: the world advances BETWEEN calls, not during
  // them. Look at the result, then act again.
  {
    name: 'editor_pie_widget_tree',
    description:
      'WHAT IS ON SCREEN RIGHT NOW in the running game: every visible Slate/UMG widget with its type, text and on-screen rectangle. USE_WHEN: before interacting — this is how you find a button instead of guessing coordinates. NOT_WHEN: inspecting a Widget Blueprint asset rather than the live screen (ui_query).',
    meta: pieWidgetTreeMeta,
    handler: pieWidgetTreeHandler,
    cost: 'low',
    returns: '{widgets:[{type, tag, text, x, y, width, height, center_x, center_y, enabled, interactive}], count}',
    niche: PIE,
    schema: pieWidgetTreeSchema.shape,
  },
  {
    name: 'editor_pie_click_widget',
    description:
      'CLICK A CONTROL BY WHAT IT SAYS rather than by pixel. Finds the widget whose text, tag or type matches and clicks its centre, preferring an interactive one so matching a label presses the button containing it. Reports how many matched, so an ambiguous choice is visible instead of silent. USE_WHEN: pressing menu buttons. NOT_WHEN: you need an exact position.',
    meta: pieClickWidgetMeta,
    handler: pieClickWidgetHandler,
    cost: 'medium',
    returns: '{match, clicked_type, clicked_text, x, y, candidates, note?}',
    niche: PIE,
    schema: pieClickWidgetSchema.shape,
  },
  {
    name: 'editor_pie_mouse',
    description:
      'Drive the mouse in the running game: move, click, double_click, press, release, drag or scroll. press/release let you hold a button across calls; drag interpolates intermediate positions because widgets that track deltas ignore a single jump. x/y are ABSOLUTE desktop pixels — pass center_x/center_y from editor_pie_widget_tree straight through. Check focused_widget_after: if it says SViewport, the click missed the UI. PREFER editor_pie_click_widget when you know the label.',
    meta: pieMouseMeta,
    handler: pieMouseHandler,
    cost: 'medium',
    returns: '{action, x, y, coordinate_space, absolute_x, absolute_y, focused_widget_after, button, dispatched}',
    niche: PIE,
    schema: pieMouseSchema.shape,
  },
  {
    name: 'editor_pie_type_text',
    description:
      'Type a string into the running game as character input, which is what text fields actually consume. Goes to whatever holds keyboard focus — click the field first. Read characters_accepted_by_ui, NOT characters_sent: the first says the text landed in a widget, the second only says it was sent. USE_WHEN: filling in a name or search box. NOT_WHEN: a single control key like Enter (editor_pie_press_key).',
    meta: pieTypeTextMeta,
    handler: pieTypeTextHandler,
    cost: 'medium',
    returns: '{text, characters_sent, characters_accepted_by_ui, focused_widget, warning?, note}',
    niche: PIE,
    schema: pieTypeTextSchema.shape,
  },
  {
    name: 'editor_pie_set_text',
    description:
      'Put a value straight into a text field and tell the game about it. PREFER THIS over editor_pie_type_text when you just need to get past a field — typed characters go wherever focus happens to be, can be eaten by a modal, and are lost if focus moves before the widget commits. Find the field by the text ON it (the placeholder counts, so an empty login box matches "Username"), or omit match to use the focused field. Returns readback+verified, so you know the value is actually in the box. USE_WHEN: filling a login/search/name field. NOT_WHEN: you are testing how the game itself handles keystrokes.',
    meta: pieSetTextMeta,
    handler: pieSetTextHandler,
    cost: 'medium',
    returns: '{text, target_type, found_by, applied, readback, verified, committed, warning?}',
    niche: PIE,
    schema: pieSetTextSchema.shape,
  },
  {
    name: 'editor_pie_press_key',
    description:
      'Press a keyboard or gamepad button in the running game. pressed_and_released schedules the release on a later tick and RETURNS IMMEDIATELY — the key is still down when you read the result, which is what lets the game see the hold at all.',
    meta: piePressKeyMeta,
    handler: piePressKeyHandler,
    cost: 'medium',
    returns: '{key, event, dispatched, focused_widget, handled_by_ui, release_scheduled, release_after_ms?}',
    niche: PIE,
    schema: piePressKeySchema.shape,
  },
  {
    name: 'editor_pie_axis',
    description:
      'Send analog input — gamepad sticks and triggers, mouse axes. Applies for the frame it is delivered, so send it again per step for sustained movement rather than expecting it to latch.',
    meta: pieAxisMeta,
    handler: pieAxisHandler,
    cost: 'medium',
    returns: '{key, value, note}',
    niche: PIE,
    schema: pieAxisSchema.shape,
  },
  {
    name: 'editor_pie_screenshot',
    description:
      'Capture the running game. Requests the shot and returns immediately; the engine writes the file a frame or two later, so poll with check_only:true and the same filename rather than assuming it is ready. NOT_WHEN: capturing the editor viewport outside PIE (editor_capture_viewport).',
    meta: pieScreenshotMeta,
    handler: pieScreenshotHandler,
    cost: 'medium',
    returns: '{filename, requested, captured, note}',
    niche: PIE,
    schema: pieScreenshotSchema.shape,
  },

  // ── Content audits + validation ───────────────────────────────────────────
  {
    name: 'texture_audit',
    description:
      'WHICH TEXTURES ARE COSTING MEMORY: every Texture2D ranked by resource size, with dimensions, format, LOD group and compression, and a flag where the name implies a role the compression contradicts. USE_WHEN: chasing memory or load times. NOT_WHEN: inspecting one texture you already know about (texture_get_info).',
    meta: textureAuditMeta,
    handler: textureAuditHandler,
    cost: 'medium',
    returns: '{textures:[{path, size_x, size_y, format, memory_kb, lod_group, compression, outlier}], scanned, count, top_n_total_kb}',
    niche: CONTENT,
    schema: textureAuditSchema.shape,
  },
  {
    name: 'mesh_audit',
    description:
      'WHICH MESHES ARE COSTING FRAME TIME: static meshes with LOD0 triangle counts, LOD count, material slot count and how many things reference them. USE_WHEN: a scene is heavy and you need to know where the triangles and draw calls actually are.',
    meta: meshAuditMeta,
    handler: meshAuditHandler,
    cost: 'medium',
    returns: '{meshes:[{path, tris_lod0, lod_count, missing_lods, material_slot_count, referencer_count}], scanned, count}',
    niche: CONTENT,
    schema: meshAuditSchema.shape,
  },
  {
    name: 'content_validate',
    description:
      'CHECK PROJECT CONTENT AGAINST MEMORY AND PERFORMANCE BUDGETS: oversized textures, compression that contradicts the asset name, non-power-of-two dimensions, UI textures outside the UI group, meshes with no LODs, excessive material slots, unreferenced meshes. Judged per strictness (relaxed/standard/strict) with every threshold justified in the hint. Reports what it did NOT examine — the audits only cover the heaviest N assets, so a clean result is scoped, never a claim about the whole project. NOT_WHEN: checking a UI screen (ui_validate).',
    meta: contentValidateMeta,
    handler: contentValidateHandler,
    cost: 'medium',
    returns:
      '{strictness, findings:[{ruleId, severity, asset, message, hint, data}], rules_evaluated, rules_skipped_no_data[], counts, coverage:{textures_reported, textures_scanned, truncated}}',
    niche: CONTENT,
    schema: contentValidateSchema.shape,
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
    description:
      'Wait for UE shader compilation to settle (or timeout). Thin wrapper around wait_for_idle({subsystems:["shaders"]}).',
    meta: waitForShadersMeta,
    handler: async (args, _session) => handleWaitForShaders(args as any) as never,
    cost: 'high',
    returns: '{settled:bool, waited_ms:int} or legacy {status, subsystems}',
    schema: {
      max_seconds: z.number().int().min(1).max(600).optional().describe('Upper bound in seconds (default 60).'),
      poll_seconds: z
        .number()
        .min(0.05)
        .max(10)
        .optional()
        .describe('Poll interval in seconds (default 1). NOTE: ignored — UE-side polling is fixed at 250ms.'),
    },
  },
  {
    name: 'wait_for_idle',
    description:
      'Wait for UE subsystems (shaders/assets/gc/pcg/world_tick) to settle before reading back or rendering. Default = shaders+assets+gc+pcg.',
    meta: waitForIdleMeta,
    handler: async (args, _session) => handleWaitForIdle(args as never) as never,
    cost: 'high',
    returns: '{settled, subsystems:{shaders,assets,gc,pcg,world_tick}}',
    schema: waitForIdleSchema.shape,
  },
  {
    name: 'render_camera',
    description:
      'Render a camera view to disk and VERIFY the file landed (magic bytes + dimensions). Accepts either an actor reference or an inline transform. Calls wait_for_idle internally before capture.',
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
      target_dir: z
        .string()
        .optional()
        .describe('Project content path, e.g. /Game/Fab/MyAsset. Defaults to /Game/Fab/<asset_id>.'),
      wait: z
        .boolean()
        .optional()
        .describe('If true, blocks until download completes (up to 10min cap on the C++ side). Default true.'),
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
      target_dir: z
        .string()
        .optional()
        .describe('UE content path. Defaults to /Game/AssetConnectors/polyhaven/<asset_id>.'),
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
      resolution: z
        .string()
        .optional()
        .describe('Attribute string (e.g. "1K-JPG", "2K-JPG", "4K-PNG"). Default "2K-JPG".'),
      target_dir: z
        .string()
        .optional()
        .describe('UE content path. Defaults to /Game/AssetConnectors/ambientcg/<asset_id>.'),
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
  // PCG graph-EDIT tools (2026-07 postmortem §2a–2e): the destructive/introspect
  // half that previously forced python_run fallbacks.
  toToolDescriptor(pcgRemoveNodeDescriptor),
  toToolDescriptor(pcgDisconnectDescriptor),
  toToolDescriptor(pcgLayoutDescriptor),
  toToolDescriptor(pcgListPinsDescriptor),
  toToolDescriptor(pcgGetNodeDescriptor),

  // ── Actor-domain P0 breadth tools (Phase 2 Wave 1) — factory path ─────────
  // Net-new actor tools (inspect/find/selection/spawn-from-asset/batch-
  // transform/focus/set-folder), generated as UE Python via the pyTemplate
  // factory. See src/tools/actor/actor-py-tools.ts for the overlap analysis.
  ...actorPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Editor-introspection & observability P0 tools (Phase 2 Wave 2) ────────
  // Net-new editor/reflection/asset-registry read + gating tools, generated as
  // UE Python via the pyTemplate factory. See src/tools/editor/editor-py-tools.ts
  // for the catalog overlap/skip analysis.
  ...editorPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Asset & mesh P0 tools (Phase 2 Wave 2, Task 2) — factory path ─────────
  // Net-new asset-provenance/save/folder tools and StaticMesh-asset readbacks
  // (sockets/LODs/materials/bounds + material-slot setter), generated as UE
  // Python via the pyTemplate factory. See src/tools/asset/asset-py-tools.ts
  // and src/tools/mesh/mesh-py-tools.ts for the catalog overlap/skip analysis.
  ...assetPyDescriptors.map((d) => toToolDescriptor(d)),
  ...meshPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Sequencer & cinematics P0/P1 tools (Phase 2 Wave 4, Task 1) ───────────
  // Net-new sequence authoring/inspection/validation tools, generated as UE
  // Python via the pyTemplate factory. Names are deliberately non-colliding
  // with the dormant HaybaMCPSequencer satellite-plugin C++ commands (render
  // tools wrapped-and-skipped). See src/tools/sequencer/sequencer-py-tools.ts
  // for the 3-surface overlap audit and render decision.
  ...sequencerPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Niagara & VFX P0/P1 tools (Phase 2 Wave 4, Task 2) ────────────────────
  // Net-new Niagara discovery/inspection/spawn/param/validation tools,
  // generated as UE Python via the pyTemplate factory. Names are deliberately
  // non-colliding with the dormant HaybaMCPNiagara satellite-plugin C++
  // commands (niagara_list/niagara_spawn/niagara_set_param). See
  // src/tools/niagara/niagara-py-tools.ts for the 3-surface overlap audit and
  // wrap-and-skip decisions.
  ...niagaraPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Water system P0 tools (Phase 2 Wave 4, Task 3) ────────────────────────
  // Net-new water body/zone/wave discovery, spawn, tuning and PLUMB-style
  // validation, generated as UE Python via the pyTemplate factory. All names
  // are net-new + unique across all 3 surfaces (no water_* command exists in
  // sidecar/index/list-tool-categories or any unreal GetCommands). The Water
  // plugin may be DISABLED — water_check_plugin is the honest gate and every
  // tool degrades to a clean plugin-disabled envelope. See
  // src/tools/water/water-py-tools.ts for the overlap audit + plugin-probe.
  ...waterPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Landscape & terrain P0/P1 tools (Phase 2 Wave 3, Task 1) — factory path ─
  // Net-new landscape read/introspection (list/inspect/layer-list/get-material/
  // list-splines) + set-to-value reflection writers (set-material/set-lod/
  // set-nanite) + LayerInfo authoring (add-layer). See
  // src/tools/landscape/landscape-py-tools.ts for the catalog overlap/skip
  // analysis (C++ edit-data & import handlers deliberately not re-implemented).
  ...landscapePyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Foliage & scatter P0 tools (Phase 2 Wave 3, Task 2) — factory path ─────
  // Net-new foliage-SYSTEM authoring: capability-probe + type/instance reads,
  // set-to-value typed-param + mesh writers, and non-idempotent create/add/
  // scatter/remove/clear verbs, generated as UE Python via the pyTemplate
  // factory. Direct low-level foliage authoring — NOT the PLUMB-validated
  // world_generate flagship. See src/tools/foliage/foliage-py-tools.ts for the
  // catalog overlap/skip analysis and UNCERTAIN-API flags.
  ...foliagePyDescriptors.map((d) => toToolDescriptor(d)),

  // ── Lighting & post-process P0/P1 tools (Phase 2 Wave 3, Task 3) — factory ──
  // Net-new lighting/post-process AUTHORING: capability-probe + light/PPV reads,
  // set-to-value light/PP/exposure/Lumen/color-grade/fog writers (each PP writer
  // sets the bOverride_* flag alongside the value + writes the settings struct
  // back), and non-idempotent light_spawn / postprocess_spawn_volume / sky_setup.
  // Skips the render/vision-loop/job-envelope + PLUMB-validator catalog entries.
  // See src/tools/lighting/lighting-py-tools.ts for the 3-surface overlap audit,
  // the bOverride gotcha handling, skip analysis and UNCERTAIN-API flags.
  ...lightingPyDescriptors.map((d) => toToolDescriptor(d)),

  // ── BYOK copilot config/introspection (Task 5) ────────────────────────────
  // Pure-TS descriptors reading/writing the SAME in-memory config store the
  // /chat/config sidecar routes use (src/chat/chat-server.ts). See
  // src/tools/copilot/copilot-tools.ts for the vault TODO (Task 6).
  {
    name: 'copilot_provider_list',
    description:
      'List the BYOK provider catalog, flagging which provider is active and whether a key is configured for it (masked last-4 only).',
    meta: providerListMeta,
    handler: providerListHandler,
    cost: 'low',
    returns:
      '{providers:[{id,label,protocol,needs_key,key_hint,default_model,base_url_default,active,key_configured,key_last4}], active_provider}',
    niche: PACK,
    schema: {
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_provider_set',
    description: 'Set the active BYOK provider (and optional model/base URL) for a copilot session.',
    meta: providerSetMeta,
    handler: providerSetHandler,
    cost: 'low',
    returns: '{ok, provider, model, base_url, key_last4}',
    niche: PACK,
    schema: {
      provider: z.string().min(1).describe('Provider id from copilot_provider_list, e.g. "anthropic"'),
      model: z.string().optional().describe('Override the provider default model'),
      base_url: z
        .string()
        .optional()
        .describe('Override the provider default base URL (e.g. self-hosted OpenAI-compat endpoint)'),
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_provider_test',
    description:
      'Preflight-check a BYOK provider: fails clean with {ok:false, reason:"no_key"} (no network call) if a key is required but absent; otherwise runs a minimal completion probe and reports latency.',
    meta: providerTestMeta,
    handler: providerTestHandler,
    cost: 'low',
    returns: '{ok, latency_ms?, model?, reason?, detail?}',
    niche: PACK,
    schema: {
      provider: z.string().optional().describe('Provider id to test; defaults to the configured active provider'),
      model: z.string().optional().describe('Model id to test; defaults to the configured/default model'),
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_model_list',
    description:
      'List known model ids for a BYOK provider (advisory starting point only — BYOK users may use any id their key/endpoint supports).',
    meta: modelListMeta,
    handler: modelListHandler,
    cost: 'low',
    returns: '{provider, default_model, configured_model, known_models:[string], advisory:true, note}',
    niche: PACK,
    schema: {
      provider: z.string().min(1).describe('Provider id from copilot_provider_list'),
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_key_set',
    description:
      'Set the BYOK API key for a provider. The key is NEVER echoed back or logged — the response contains only a masked last-4. Stored in-memory (TODO Task 6: swaps to the C++ DPAPI vault).',
    meta: keySetMeta,
    handler: keySetHandler,
    cost: 'low',
    returns: '{ok, provider, key_last4}',
    niche: PACK,
    schema: {
      provider: z.string().min(1).describe('Provider id from copilot_provider_list'),
      api_key: z.string().min(1).describe('The raw API key (never returned or logged)'),
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_key_clear',
    description: 'Clear the stored BYOK API key for a provider. Destructive — plan-gated when Plan Mode is on.',
    meta: keyClearMeta,
    handler: keyClearHandler,
    cost: 'low',
    returns: '{ok, provider, cleared}',
    niche: PACK,
    schema: {
      provider: z.string().min(1).describe('Provider id whose key should be cleared'),
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_key_status',
    description: 'Report, per provider, whether a BYOK key is configured (masked last-4 only, no network call).',
    meta: keyStatusMeta,
    handler: keyStatusHandler,
    cost: 'low',
    returns: '{providers:[{provider,configured,last4?}]}',
    niche: PACK,
    schema: {
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
  {
    name: 'copilot_health',
    description:
      'Cheap health snapshot for the copilot stack: sidecar chat routes registered, UE bridge reachable, tool registry size, and the active provider.',
    meta: healthMeta,
    handler: healthHandler,
    cost: 'low',
    returns: '{sidecar_ok, ue_connected, tools_available, active_provider}',
    niche: PACK,
    schema: {
      session_id: z.string().optional().describe('Chat session id; omitted = the default/global config slot'),
    },
  },
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
  ...AUDIO_DESCRIPTORS,
  ...VALIDATOR_DESCRIPTORS,
  ...PLUMB_DESCRIPTORS,
  ...PCG_DESCRIPTORS,
  ...generateLegacyDescriptors(
    new Set(
      [
        ...HANDWRITTEN_STANDARD_DESCRIPTORS,
        ...AUDIO_DESCRIPTORS,
        ...VALIDATOR_DESCRIPTORS,
        ...PLUMB_DESCRIPTORS,
        ...PCG_DESCRIPTORS,
      ].map((d) => d.name),
    ),
  ),
];

const ueStatusMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking whether the Unreal editor bridge is reachable before an editor operation',
  not_when: 'a just-completed editor call already proved the bridge is reachable',
};

/**
 * Tools exposed even when the large eager catalogue is hidden by Code Mode.
 *
 * They used to be hand-written `server.tool(...)` calls with separate schema
 * registry entries. `wireSchema` preserves the two compatibility aliases while
 * `schema` remains the canonical signature shown to agents.
 */
export const CODE_MODE_DESCRIPTORS: ToolDescriptor[] = [
  defineTool({
    name: 'list_tool_categories',
    description:
      'List all HaybaOS command domains and their commands. Call this first to discover what is available before requesting a specific schema.',
    meta: listMeta,
    schema: {},
    cost: 'low',
    returns: '{categories:[{domain,commands:[string]}]}',
    handler: async (_params, session) => listToolCategoriesHandler({}, session),
  }),
  defineTool({
    name: 'get_tool_signature',
    description:
      'Return the JSON schema (params, return shape, cost) for a specific HaybaOS command. Call list_tool_categories first to find command names.',
    meta: sigMeta,
    schema: {
      command: z.string().describe('Exact command name, e.g. "actor_spawn"'),
    },
    wireSchema: {
      command: z.string().optional().describe('Exact command name, e.g. "actor_spawn"'),
      name: z.string().optional().describe('Alias for "command".'),
    },
    cost: 'low',
    returns: '{command, params, returns, cost} or {status:"no_schema_available", did_you_mean}',
    handler: async (params, session) => {
      const resolved = resolveAliases(params as Record<string, unknown>, TOOL_ALIASES.get_tool_signature);
      if (!resolved.ok) return errorResult(`Validation error: ${resolved.error}`);
      return getToolSignatureHandler(resolved.args, session);
    },
  }),
  defineTool({
    name: 'python_run',
    description:
      'Execute a Python script inside UE via PythonScriptPlugin. Universal escape hatch for invoking any UE command not otherwise exposed.',
    meta: pyMeta,
    schema: {
      script: z.string().describe('Python source to execute'),
      allow_unsafe: z
        .boolean()
        .optional()
        .describe(
          'Override only the Tier 3 filesystem/subprocess policy (DANGEROUS). It cannot bypass crash, deadlock, editor-lifetime, or execution-deadline guards.',
        ),
    },
    wireSchema: {
      script: z.string().optional().describe('Python source to execute'),
      code: z.string().optional().describe('Alias for "script".'),
      allow_unsafe: z
        .boolean()
        .optional()
        .describe(
          'Override only the Tier 3 filesystem/subprocess policy (DANGEROUS). It cannot bypass crash, deadlock, editor-lifetime, or execution-deadline guards.',
        ),
    },
    cost: 'high',
    returns: '{ok, tier, stdout, stderr}',
    handler: async (params, session) => pythonRunHandler(params as Record<string, unknown>, session),
  }),
];

/** Eager-only tools whose wrappers need a small amount of local orchestration. */
export const SPECIAL_EAGER_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'editor_capture_viewport',
    description:
      'Capture the active editor viewport and return it as an inline image block (plus a small text block with camera/width/height). Set HAYBA_CAPTURE_TO_FILE to also spill the image to a temp file path.',
    meta: captureMeta,
    schema: {
      width: z.coerce.number().int().optional(),
      height: z.coerce.number().int().optional(),
      wait_for_shaders: z
        .boolean()
        .optional()
        .describe('If true, calls wait_for_shaders first (max_seconds=60, poll_seconds=1).'),
    },
    cost: 'medium',
    returns: '{width, height, camera, ...} + the capture as an image block',
    handler: async (params, session) => {
      if (params.wait_for_shaders === true) {
        await handleWaitForShaders({ max_seconds: 60, poll_seconds: 1 });
      }
      return editorCaptureViewportHandler(params as Record<string, unknown>, session);
    },
  },
  defineTool({
    name: 'editor_stream_log',
    description: 'Tail recent UE log lines (paged via since_line).',
    meta: streamLogMeta,
    schema: {
      filter: z.string().optional(),
      since_line: z.coerce.number().int().nonnegative().optional(),
    },
    cost: 'low',
    returns: '{lines:[string], next_line:int}',
    handler: async (params, session) => editorStreamLogHandler(params as Record<string, unknown>, session),
  }),
  defineTool({
    name: 'hayba_check_ue_status',
    description: 'Check whether the Unreal editor bridge is reachable and report its current identity and status.',
    meta: ueStatusMeta,
    schema: {},
    cost: 'low',
    returns: '{connected, status, ueVersion, plugin, pluginVersion}',
    handler: async () => okResult(await checkUeStatus()),
  }),
];

/** Every statically declared tool, independent of which routing mode exposes it. */
export const STATIC_TOOL_CATALOGUE: ReadonlyArray<ToolDescriptor> = [
  ...CODE_MODE_DESCRIPTORS,
  ...STANDARD_DESCRIPTORS,
  ...SPECIAL_EAGER_DESCRIPTORS,
];

/**
 * Convert the static catalogue directly into the deferred-routing value map.
 * No registration code runs and no real or fake `server.tool` is involved.
 */
export function captureStaticToolCatalogue(
  session: SessionManagerStub,
): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>();
  for (const descriptor of STATIC_TOOL_CATALOGUE) {
    if (captured.has(descriptor.name)) {
      throw new Error(`duplicate static tool descriptor: ${descriptor.name}`);
    }
    registerToolMeta(descriptor.name, descriptor.meta);
    const tool = materializeTool(session, descriptor);
    captured.set(tool.name, {
      description: tool.description,
      schema: tool.schema,
      handler: wrapToolHandlerForStream(tool.name, tool.handler) as CapturedTool['handler'],
      dir: inferDir(tool.name),
    });
  }
  return captured;
}

export async function registerTools(
  server: McpServer,
  session: SessionManagerStub,
  /** Forwarded to registerDeferredRouting. Exists so a test can pass a
   *  lexical-only embedding backend instead of letting the default probe reach
   *  the network — without it this function is untestable, which is how the
   *  catalogue-construction path went uncovered for as long as it did. */
  options: DeferredRoutingOptions = {},
): Promise<RoutingHandle | null> {
  // Retry policy is startup wiring, not an import-time side effect of building
  // the sidecar descriptor values.
  registerLegacyNonIdempotent();

  // Runtime wiring is independent of catalogue construction. In particular,
  // neither call below is made against a capture stand-in.
  void installLiveSender();
  installToolStreamMirror(server);

  // Signatures exist in every mode, including Code Mode where most native MCP
  // registrations are deliberately hidden until discovered.
  seedCatalogueSchemas();

  const settings = readSettings();
  if (settings.toolRouting === 'deferred') {
    // γ-hybrid: the complete static catalogue is already data. Convert the
    // descriptors straight into the captured map; registration is no longer
    // executed for its side effects merely to discover what would register.
    const captured = captureStaticToolCatalogue(session);
    installToolHooks();

    // Now register meta-tools + alwaysLoadPacks. Awaited so the caller can
    // sequence server.connect() after every server.tool() call has happened
    // — McpServer rejects late registrations with "Cannot register
    // capabilities after connecting to transport".
    const handle = await registerDeferredRouting(server, captured, undefined, options);
    return handle;
  }

  for (const descriptor of CODE_MODE_DESCRIPTORS) {
    registerTool(server, session, descriptor);
  }

  // Code Mode keeps the native surface small. The descriptors and signatures
  // still exist as values above; only native registration is skipped.
  if (config.codeMode) return null;

  for (const descriptor of STANDARD_DESCRIPTORS) {
    registerTool(server, session, descriptor);
  }
  for (const descriptor of SPECIAL_EAGER_DESCRIPTORS) {
    registerTool(server, session, descriptor);
  }
  installToolHooks();
  return null;
}

/**
 * Infer the pack-source directory for a tool name by matching against the
 * known top-level dirs under src/tools/. Root-level tools return null.
 *
 * Exported so the deferred-routing regression tests can assert a domain's
 * tools group under the expected pack (the "hidden until searched" surface —
 * deriveDomainPacks buckets by this dir, and ToolIndex indexes by it).
 */
/**
 * Measured bounds for an asset, used when baking a PLUMB profile.
 *
 * Hoisted to module scope so plumb_profile_bake can be a static descriptor.
 * Goes through the executeCommand seam, so the in-memory adapter can script it
 * in tests without a live editor.
 */
const fetchMeshBounds = async (asset: string) => {
  const data = (await executeCommand('mesh_get_info', { path: asset })) as {
    bounds?: { min: Record<string, number>; max: Record<string, number>; extents: Record<string, number> };
  };
  const b = data?.bounds;
  if (!b) throw new Error('mesh_get_info returned no bounds');
  const v = (o: Record<string, number>): [number, number, number] => [o.x ?? 0, o.y ?? 0, o.z ?? 0];
  return { min: v(b.min), max: v(b.max), extents: v(b.extents) };
};

export function inferDir(name: string): string | null {
  if (name.startsWith('actor_')) return 'actor';
  if (name.startsWith('scene_')) return 'scene';
  if (name.startsWith('editor_')) return 'editor';
  if (name.startsWith('material_')) return 'material';
  if (name.startsWith('memory_')) return 'memory';
  if (name.startsWith('ui_')) return 'ui';
  if (name.startsWith('hayba_fab_')) return 'fab';
  if (name.startsWith('hayba_polyhaven_')) return 'asset-sources';
  if (name.startsWith('hayba_ambientcg_')) return 'asset-sources';
  if (name.startsWith('hayba_sketchfab_')) return 'asset-sources';
  if (name === 'python_run') return 'python';
  if (name === 'list_tool_categories' || name === 'get_tool_signature') return 'code-mode';
  return null;
}

// Schema registry seeding reads the same descriptors as eager registration and
// deferred capture, independently of which routing mode exposes them.
function seedCatalogueSchemas(): void {
  for (const descriptor of STATIC_TOOL_CATALOGUE) recordToolSchema(descriptor);
}
