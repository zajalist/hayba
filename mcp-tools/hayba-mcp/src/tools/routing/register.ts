// Wiring for γ-hybrid tool routing. Called from tools/index.ts when
// settings.toolRouting === 'deferred'. Expects the caller to have already
// captured every original server.tool(...) registration into `captured` via
// a shim, and to have populated `schema-registry` via the existing `reg(...)`
// helper. We don't re-walk the tool catalog here — we read from those.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings-watcher.js';
import { PackRegistry, type PackDef } from './pack-registry.js';
import { ToolIndex, type ToolDoc } from './tool-index.js';
import { selectEmbeddingBackend } from './embedding-backends.js';
import { deriveDomainPacks, loadWorkflowPacks } from './pack-discovery.js';
import { searchToolsHandler, searchToolsSchema } from './meta-tools/search-tools.js';
import { packListHandler, packListSchema } from './meta-tools/pack-list.js';
import { packLoadHandler, packLoadSchema } from './meta-tools/pack-load.js';
import { invokeHandler, invokeSchema } from './meta-tools/invoke.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';
import { executeCommand } from '../tool-executor.js';
import { getToolMeta } from '../tool-meta-registry.js';
import { checkUeStatus } from '../check-ue-status.js';
import { AssetRetriever, setDefaultRetriever } from '../asset-retriever/asset-retriever.js';
import { assetSearchHandler, assetSearchSchema } from '../asset-retriever/meta-tools/search.js';
import { assetBrowseHandler, assetBrowseSchema } from '../asset-retriever/meta-tools/browse.js';
import { assetReindexHandler, assetReindexSchema } from '../asset-retriever/meta-tools/reindex.js';
import { setupSliverSystem, type SliverSystem } from '../../slivers/index.js';
import { sliverListHandler, sliverListSchema } from '../sliver/list.js';
import { sliverGetHandler,  sliverGetSchema  } from '../sliver/get.js';
import { sliverRunHandler,  sliverRunSchema  } from '../sliver/run.js';
import { sliverImportHandler, sliverImportSchema } from '../sliver/import.js';
import { setupDagSystem, type DagSystem } from '../../dag/index.js';
import { dagStatusHandler, dagStatusSchema } from '../dag/status.js';
import { dagRecordHandler, dagRecordSchema } from '../dag/record.js';
import { dagRebuildHandler, dagRebuildSchema } from '../dag/rebuild.js';
import { journalTailHandler, journalTailSchema } from '../dag/journal-tail.js';
import { setAssetDagSink } from '../asset-sources/shared.js';

/** Tools registered by registerDeferredRouting itself — skip in shim re-register. */
export const ALWAYS_ON_META = new Set<string>([
  'hayba_search_tools',
  'hayba_pack_list',
  'hayba_pack_load',
  'hayba_invoke',
  'hayba_check_ue_status',
  'list_tool_categories',
  'get_tool_signature',
  'hayba_asset_search',
  'hayba_asset_browse',
  'hayba_asset_reindex',
  'hayba_sliver_list',
  'hayba_sliver_get',
  'hayba_sliver_run',
  'hayba_sliver_import',
  'hayba_dag_status',
  'hayba_dag_record',
  'hayba_dag_rebuild',
  'hayba_journal_tail',
  'validator_run',
  'validator_history',
  'validator_resolve',
  'validator_clear',
  'validator_rules',
  'validator_set_rule_enabled',
]);

export interface CapturedTool {
  /** Description string passed to server.tool (may be empty). */
  description?: string;
  /** Original Zod raw shape. */
  schema: z.ZodRawShape;
  /** Original handler — same callable shape used by McpServer. */
  handler: (...args: unknown[]) => unknown;
  /** Directory under src/tools/, or null for root-level. */
  dir: string | null;
}

export interface RoutingHandle {
  registry: PackRegistry;
  index: ToolIndex;
  retriever: AssetRetriever;
  slivers: SliverSystem;
  dag: DagSystem;
  /** Trigger autoload — wire to `check_ue_status.onConnected`. */
  onUeConnected: () => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Build the deferred-mode routing layer.
 *
 * @param server          The real MCP server (used to register meta-tools + on pack load).
 * @param captured        Map of every tool name → its descriptor (filled by the shim).
 * @param cacheDir        Where to persist the tool index (defaults to Saved/HaybaMCP).
 */
export async function registerDeferredRouting(
  server: McpServer,
  captured: Map<string, CapturedTool>,
  cacheDir?: string,
): Promise<RoutingHandle> {
  const settings = readSettings();
  const effectiveCacheDir = cacheDir
    ?? process.env.HAYBA_TOOL_INDEX_DIR
    ?? resolve(process.cwd(), 'Saved/HaybaMCP');

  // ── Pack discovery ─────────────────────────────────────────────────────────
  const toolDirs = new Map<string, string | null>();
  const explicitPacks = new Map<string, string>();
  for (const [name, desc] of captured) {
    toolDirs.set(name, desc.dir);
    const m = getToolMeta(name);
    if (m?.pack) explicitPacks.set(name, m.pack);
  }
  const domainPacks = deriveDomainPacks(toolDirs, explicitPacks);
  let workflowPacks: PackDef[] = [];
  try {
    workflowPacks = loadWorkflowPacks(resolve(__dirname, 'packs.yaml'));
  } catch (e) {
    console.warn(`[routing] failed to load packs.yaml: ${(e as Error).message}`);
  }

  // Validate workflow pack references — log warning for unknown tools.
  const knownNames = new Set(captured.keys());
  for (const wp of workflowPacks) {
    for (const tn of wp.tools) {
      if (!knownNames.has(tn)) {
        console.warn(`[routing] workflow pack "${wp.name}" references unknown tool "${tn}"`);
      }
    }
  }

  // ── PackRegistry with listChanged hook ─────────────────────────────────────
  const registeredNames = new Set<string>();
  const registerByName = (name: string): void => {
    if (registeredNames.has(name)) return;
    if (isToolDisabled(name)) return;
    const t = captured.get(name);
    if (!t) return;
    // Match McpServer.tool overload: (name, description?, schema, handler)
    if (t.description !== undefined) {
      (server as unknown as { tool: (...a: unknown[]) => void }).tool(
        name, t.description, t.schema, t.handler,
      );
    } else {
      (server as unknown as { tool: (...a: unknown[]) => void }).tool(
        name, t.schema, t.handler,
      );
    }
    registeredNames.add(name);
  };

  const onPacksChanged = async (): Promise<void> => {
    for (const name of registry.loadedTools()) registerByName(name);
    // McpServer fires notifications/tools/list_changed automatically on new tool().
  };

  const registry = new PackRegistry([...domainPacks, ...workflowPacks], onPacksChanged);

  // ── ToolIndex ──────────────────────────────────────────────────────────────
  const embeddings = await selectEmbeddingBackend();
  const docs: ToolDoc[] = Array.from(captured.entries()).map(([name, t]) => {
    const m = getToolMeta(name);
    const dirPack = m?.pack ?? t.dir ?? 'core';
    const packs = [dirPack, ...workflowPacks.filter(w => w.tools.includes(name)).map(w => w.name)];
    const summary = m?.when ?? t.description ?? '';
    const description = t.description ?? '';
    return {
      name,
      summary,
      description,
      tags: m?.effects ?? [],
      packs: Array.from(new Set(packs)),
      cost: (m?.cost ?? 'medium'),
    };
  });
  const index = await ToolIndex.build(docs, { embeddings, cacheDir: effectiveCacheDir });

  // ── Register the 4 new meta-tools ──────────────────────────────────────────
  server.tool(
    'hayba_search_tools',
    'Find Hayba tools by capability before loading their pack. Hybrid BM25 + embedding search over the full tool catalog.',
    searchToolsSchema,
    async (args: { query: string; k?: number; filterPack?: string }) => {
      const r = await searchToolsHandler(args, { index });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_pack_list',
    'List available Hayba tool packs (domain + workflow), with loaded flag and tool count.',
    packListSchema,
    async () => {
      const r = await packListHandler({}, { registry });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_pack_load',
    'Load a Hayba tool pack — registers its tools natively so the client sees them on the next list refresh.',
    packLoadSchema,
    async (args: { name: string }) => {
      const r = await packLoadHandler(args, { registry });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_invoke',
    'Polymorphic dispatcher: call any Hayba tool by name without loading its pack. Best for one-off calls; load the pack for repeated use.',
    invokeSchema,
    async (args: { name: string; args: Record<string, unknown>; via?: 'ts' | 'ue_legacy' }) => {
      const r = await invokeHandler(args, {
        dispatch: async (cmd, params) => {
          // Prefer the captured handler if present — covers TS-side tools.
          const t = captured.get(cmd);
          if (t) {
            return await Promise.resolve(t.handler(params));
          }
          // Otherwise dispatch via UE bridge.
          return await executeCommand(cmd, params);
        },
        // ue_legacy route — always goes straight to the UE plugin TCP bridge,
        // skipping the captured map. Used to reach C++ handlers that have no
        // TS wrapper (e.g. landscape_import before its TS wrapper landed).
        dispatchLegacy: async (cmd, params) => {
          return await executeCommand(cmd, params);
        },
        isDisabled: isToolDisabled,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  // ── Re-register the always-on tools from the captured set ─────────────────
  // (list_tool_categories, get_tool_signature, hayba_check_ue_status are
  // captured by the shim but not registered with the real server. We register
  // them here so they appear in the deferred always-on surface.)
  const passthrough = (name: string): void => {
    const t = captured.get(name);
    if (!t) {
      console.warn(`[routing] always-on tool "${name}" missing from captured set`);
      return;
    }
    if (t.description !== undefined) {
      (server as unknown as { tool: (...a: unknown[]) => void }).tool(
        name, t.description, t.schema, t.handler,
      );
    } else {
      (server as unknown as { tool: (...a: unknown[]) => void }).tool(
        name, t.schema, t.handler,
      );
    }
    registeredNames.add(name);
  };
  passthrough('list_tool_categories');
  passthrough('get_tool_signature');
  // Validator tools — always-on so the UE plugin's Validator panel and any
  // agent can read/manage history without loading a pack.
  passthrough('validator_run');
  passthrough('validator_history');
  passthrough('validator_resolve');
  passthrough('validator_clear');
  passthrough('validator_rules');
  passthrough('validator_set_rule_enabled');

  // For hayba_check_ue_status: REPLACE the captured handler with one that
  // wires onConnected → maybeAutoLoad('ue_connected'). The captured handler
  // calls checkUeStatus() with no args, missing the autoload trigger.
  if (captured.has('hayba_check_ue_status')) {
    server.tool(
      'hayba_check_ue_status',
      {},
      async () => {
        const status = await checkUeStatus({
          onConnected: () => registry.maybeAutoLoad('ue_connected'),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
      },
    );
    registeredNames.add('hayba_check_ue_status');
  }

  // ── Asset retriever (Layer 3a) ─────────────────────────────────────────────
  const retriever = new AssetRetriever(
    (cmd, params) => executeCommand(cmd, params ?? {}),
    { cacheDir: effectiveCacheDir },
  );
  setDefaultRetriever(retriever);

  server.tool(
    'hayba_asset_search',
    'Find an asset in the user\'s UE Content Browser by semantic intent or keyword. Hybrid BM25 + embedding search.',
    assetSearchSchema,
    async (args: { query: string; k?: number; filterClass?: string; filterSource?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }) => {
      const r = await assetSearchHandler(args, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_asset_browse',
    'Enumerate assets by filter (path/class/tag/source) without semantic ranking. Paginated.',
    assetBrowseSchema,
    async (args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number }) => {
      const r = await assetBrowseHandler(args, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_asset_reindex',
    'Force a rebuild of the asset index. Use after a batch import outside the MCP-tracked download flow.',
    assetReindexSchema,
    async () => {
      const r = await assetReindexHandler({}, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  // ── DAG + journal (Layer 2 — operation tracking) ───────────────────────────
  const dag = setupDagSystem();

  // Asset-source verified writes feed the journal.
  setAssetDagSink((writeUri) => {
    dag.recordMutation({ actor: 'asset', reads: [], writes: [writeUri], paramsHash: '', ok: true });
  });

  // ── Slivers (Layer 2 — deterministic abstractions) ─────────────────────────
  const slivers = await setupSliverSystem({
    onRun: (info) => {
      dag.recordSliverRun({
        sliverId: info.sliverId,
        params: info.params,
        declaredReads: info.declaredReads,
        writes: info.writes,
        ok: info.ok,
      });
    },
    // Side-effecting executors reach the UE bridge through ctx.dispatch.
    // executeCommand throws on transport/UE error; we convert to the
    // structured SliverDispatchResult so executors can branch on `ok`.
    ueBridge: async (cmd, params) => {
      try {
        const data = await executeCommand(cmd, params);
        return { ok: true, data: data as Record<string, unknown> };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  for (const err of slivers.loader.errors()) {
    console.warn(`[slivers] load error: ${err}`);
  }

  server.tool(
    'hayba_sliver_list',
    'List installed Slivers (deterministic abstractions). Optional category or namespace filter.',
    sliverListSchema,
    async (args: { category?: string; namespace?: string }) => {
      const r = await sliverListHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_get',
    'Get the full spec (params + determinism + executor) of an installed sliver by id.',
    sliverGetSchema,
    async (args: { id: string }) => {
      const r = await sliverGetHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_run',
    'Execute a sliver with concrete parameter values. Returns outputs + declared side_effects + durationMs.',
    sliverRunSchema,
    async (args: { id: string; params: Record<string, unknown> }) => {
      const r = await sliverRunHandler(args, { runtime: slivers.runtime });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_import',
    'Install a sliver from a local file path or an http(s) URL into the user sliver library.',
    sliverImportSchema,
    async (args: { source: string }) => {
      const r = await sliverImportHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_dag_status',
    'Show the dependency graph of generated artifacts and which are stale (dirty).',
    dagStatusSchema,
    async (args: { namespace?: string; dirtyOnly?: boolean }) => {
      const r = await dagStatusHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_dag_record',
    'Record a mutation Hayba did not instrument (editor-side edits, manual writes) so the DAG stays accurate.',
    dagRecordSchema,
    async (args: { reads?: string[]; writes: string[]; actor?: string; note?: string }) => {
      const r = await dagRecordHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_dag_rebuild',
    'Re-run stale (dirty) artifacts. Optionally restrict to the subtree under a target URI.',
    dagRebuildSchema,
    async (args: { target?: string }) => {
      const r = await dagRebuildHandler(args, {
        dag,
        runSliverNode: async (uri: string) => {
          return { ok: false, reason: uri.startsWith('sliver://')
            ? 'sliver re-run from node id is v2'
            : 'no executor for this node type' };
        },
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_journal_tail',
    'Return the most recent mutation operations from the journal.',
    journalTailSchema,
    async (args: { limit?: number }) => {
      const r = await journalTailHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  // ── Always-load packs from settings ────────────────────────────────────────
  for (const name of settings.alwaysLoadPacks) {
    const r = await registry.loadPack(name);
    if (!r.ok) {
      console.warn(`[routing] alwaysLoadPacks "${name}" not found; skipping`);
    }
  }

  return {
    registry,
    index,
    retriever,
    slivers,
    dag,
    onUeConnected: () => registry.maybeAutoLoad('ue_connected'),
  };
}
