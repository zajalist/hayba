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
import { ToolIndex, type ToolDoc, type EmbeddingBackend } from './tool-index.js';
import { selectEmbeddingBackend } from './embedding-backends.js';
import { deriveDomainPacks, loadWorkflowPacks } from './pack-discovery.js';
import { searchToolsHandler, searchToolsSchema } from './meta-tools/search-tools.js';
import { packListHandler, packListSchema } from './meta-tools/pack-list.js';
import { packLoadHandler, packLoadSchema } from './meta-tools/pack-load.js';
import { invokeHandler, invokeSchema } from './meta-tools/invoke.js';
import { toMcpResponse } from '../mcp-response.js';
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
import { registerChatCapturedTools } from '../../chat/tool-dispatch.js';
import { buildOrientation, shouldOrient } from './orientation.js';

// ── First-install surface ────────────────────────────────────────────────────
//
// What an agent sees before it asks for anything. This number matters more than
// it looks: every always-on tool spends context on every request, forever, and
// a large default set actively defeats discovery — there is no reason to search
// a catalog when 50 tools are already sitting in front of you, so the ones that
// are NOT surfaced never get found.
//
// The set below is the bootstrap minimum: what you cannot discover your way to,
// because you need it to discover. Everything else in the catalog stays
// reachable at all times without being registered:
//
//   hayba_search_tools  → find it
//   hayba_invoke        → call it (resolves from the captured map, which holds
//                         every tool regardless of pack state — loading a pack
//                         is an optimisation for repeated use, never a
//                         prerequisite)
//   hayba_pack_load     → register a domain natively when you want its schemas
//
// Before changing this, ask whether the tool is genuinely un-discoverable
// without itself being present. If an agent could find it with a search, it
// belongs in a pack.

/** The bootstrap set: needed to discover and reach everything else. */
export const CORE_META = new Set<string>([
  // Discovery.
  'hayba_search_tools',
  'list_tool_categories',
  'get_tool_signature',
  // Execution without registration.
  'hayba_invoke',
  // Progressive loading.
  'hayba_pack_list',
  'hayba_pack_load',
  // Liveness — every UE-touching tool fails confusingly without this answer,
  // and an agent cannot know to look for it.
  'hayba_check_ue_status',
]);

/** Packs auto-loaded once the UE editor is confirmed connected. Keeps the cold
 *  surface tiny while making the tools you obviously need present as soon as
 *  there is an editor to use them on. */
export const AUTOLOAD_ON_UE_CONNECT = ['editor'] as const;

/** Tools registered by registerDeferredRouting itself — skip in shim re-register.
 *
 *  Kept as a separate export because callers (and the routing integration test)
 *  treat it as "what is registered at startup". It is exactly CORE_META now;
 *  previously it also carried the whole PLUMB, validator, sliver, DAG and asset
 *  surfaces — 49 tools — which is what made the catalog unsearchable.
 *
 *  Note on PLUMB in particular: it was always-on so "the Validator/Memory panels
 *  and any agent can bake profiles without loading a pack." The panels read the
 *  PLUMB stores directly from disk (see PushMemoryResultsToPanel), so they never
 *  needed the MCP registration; and an agent reaches every one of those tools
 *  through hayba_invoke. Nothing regressed by moving them into their pack. */
export const ALWAYS_ON_META = new Set<string>(CORE_META);

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
/** Options for {@link registerDeferredRouting}.
 *
 *  `selectBackend` exists so the embedding backend is *accepted*, not created.
 *  The default probe reaches the network (Ollama on :11434, then a Hugging Face
 *  model download), which is fine for a long-lived server and fatal for a test:
 *  three integration tests used to time out at 5s on any machine without a warm
 *  model cache. Pass `() => Promise.resolve(null)` for a lexical-only index. */
export interface DeferredRoutingOptions {
  selectBackend?: () => Promise<EmbeddingBackend | null>;
}

export async function registerDeferredRouting(
  server: McpServer,
  captured: Map<string, CapturedTool>,
  cacheDir?: string,
  options: DeferredRoutingOptions = {},
): Promise<RoutingHandle> {
  // Publish the captured-tool map to the chat dispatcher (Task 4) so the sidecar
  // SSE copilot reaches TS-side handlers, not just UE-bridged commands.
  registerChatCapturedTools(captured);

  const settings = readSettings();
  const effectiveCacheDir = cacheDir
    ?? process.env.HAYBA_TOOL_INDEX_DIR
    ?? resolve(process.cwd(), 'Saved/HaybaMCP');

  // ── Runtime-constructed subsystems ─────────────────────────────────────────
  //
  // These tools cannot be declared statically: they close over live objects
  // (the asset retriever, the DAG, the sliver loader). They used to call
  // server.tool() directly, which registered all 11 unconditionally and — because
  // it ran after the search index was built — left every one of them OUT of the
  // index. They were simultaneously always in your face and impossible to find
  // by searching.
  //
  // They now go through `defer`, which puts them in the captured map like every
  // other tool. Pack discovery, the search index and hayba_invoke all read that
  // map, so they stay searchable and callable while costing nothing until asked
  // for. This block must stay ABOVE pack discovery for that to hold.

  /** Route a runtime-constructed tool through the deferred path instead of
   *  registering it natively. */
  /** Capture a runtime-constructed tool — one that closes over a live object
   *  (the retriever, the DAG, the sliver loader) and so cannot be declared
   *  statically as a descriptor.
   *
   *  `run` returns a plain JSON-serialisable value; the MCP content-block
   *  envelope is applied here via toMcpResponse. All eleven call sites used to
   *  end with the same hand-written
   *  `{ content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] }`,
   *  which is the one shape every Hayba tool returns and therefore the last
   *  thing a call site should be restating. */
  const defer = (
    dir: string,
    name: string,
    description: string,
    schema: z.ZodRawShape,
    run: (...args: never[]) => unknown,
  ): void => {
    captured.set(name, {
      description,
      schema,
      handler: (async (...args: never[]) =>
        toMcpResponse(await run(...args))) as unknown as CapturedTool['handler'],
      dir,
    });
  };

  // ── Asset retriever (Layer 3a) ─────────────────────────────────────────────
  const retriever = new AssetRetriever(
    (cmd, params) => executeCommand(cmd, params ?? {}),
    { cacheDir: effectiveCacheDir },
  );
  setDefaultRetriever(retriever);

  defer(
    'asset-sources',
    'hayba_asset_search',
    'Find an asset in the user\'s UE Content Browser by semantic intent or keyword. Hybrid BM25 + embedding search.',
    assetSearchSchema,
    (args: { query: string; k?: number; filterClass?: string; filterSource?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }) => assetSearchHandler(args, { retriever }),
  );

  defer(
    'asset-sources',
    'hayba_asset_browse',
    'Enumerate assets by filter (path/class/tag/source) without semantic ranking. Paginated.',
    assetBrowseSchema,
    (args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number }) => assetBrowseHandler(args, { retriever }),
  );

  defer(
    'asset-sources',
    'hayba_asset_reindex',
    'Force a rebuild of the asset index. Use after a batch import outside the MCP-tracked download flow.',
    assetReindexSchema,
    () => assetReindexHandler({}, { retriever }),
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

  defer(
    'sliver',
    'hayba_sliver_list',
    'List installed Slivers (deterministic abstractions). Optional category or namespace filter.',
    sliverListSchema,
    (args: { category?: string; namespace?: string }) => sliverListHandler(args, { loader: slivers.loader }),
  );

  defer(
    'sliver',
    'hayba_sliver_get',
    'Get the full spec (params + determinism + executor) of an installed sliver by id.',
    sliverGetSchema,
    (args: { id: string }) => sliverGetHandler(args, { loader: slivers.loader }),
  );

  defer(
    'sliver',
    'hayba_sliver_run',
    'Execute a sliver with concrete parameter values. Returns outputs + declared side_effects + durationMs.',
    sliverRunSchema,
    (args: { id: string; params: Record<string, unknown> }) => sliverRunHandler(args, { runtime: slivers.runtime }),
  );

  defer(
    'sliver',
    'hayba_sliver_import',
    'Install a sliver from a local file path or an http(s) URL into the user sliver library.',
    sliverImportSchema,
    (args: { source: string }) => sliverImportHandler(args, { loader: slivers.loader }),
  );

  defer(
    'dag',
    'hayba_dag_status',
    'Show the dependency graph of generated artifacts and which are stale (dirty).',
    dagStatusSchema,
    (args: { namespace?: string; dirtyOnly?: boolean }) => dagStatusHandler(args, { dag }),
  );

  defer(
    'dag',
    'hayba_dag_record',
    'Record a mutation Hayba did not instrument (editor-side edits, manual writes) so the DAG stays accurate.',
    dagRecordSchema,
    (args: { reads?: string[]; writes: string[]; actor?: string; note?: string }) => dagRecordHandler(args, { dag }),
  );

  defer(
    'dag',
    'hayba_dag_rebuild',
    'Re-run stale (dirty) artifacts. Optionally restrict to the subtree under a target URI.',
    dagRebuildSchema,
    (args: { target?: string }) => dagRebuildHandler(args, {
      dag,
      runSliverNode: async (uri: string) => {
        return { ok: false, reason: uri.startsWith('sliver://')
          ? 'sliver re-run from node id is v2'
          : 'no executor for this node type' };
      },
    }),
  );

  defer(
    'dag',
    'hayba_journal_tail',
    'Return the most recent mutation operations from the journal.',
    journalTailSchema,
    (args: { limit?: number }) => journalTailHandler(args, { dag }),
  );

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
  const embeddings = await (options.selectBackend ?? selectEmbeddingBackend)();
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

  // ── First-contact orientation ──────────────────────────────────────────────
  //
  // Appended to whichever core tool the agent happens to call first, then never
  // again. A seven-tool surface is only an improvement if the agent knows the
  // other seventy are one call away; without this it just looks like a server
  // that cannot do very much.
  const withOrientation = (
    result: { content: Array<{ type: 'text'; text: string }> },
  ): { content: Array<{ type: 'text'; text: string }> } => {
    if (!shouldOrient()) return result;
    const text = buildOrientation({
      totalTools: captured.size,
      loadedTools: Array.from(registeredNames),
      registry,
    });
    return { ...result, content: [...result.content, { type: 'text' as const, text }] };
  };


  // ── Register the 4 new meta-tools ──────────────────────────────────────────
  server.tool(
    'hayba_search_tools',
    'FIND A TOOL BY DESCRIBING WHAT YOU WANT, in plain language ("make a menu widget", "why is my landscape flat"). Searches the FULL catalogue, including the tools that are not registered yet — most of them are not, by design. Returns tool names you can pass straight to hayba_invoke without loading anything. USE_WHEN: you do not already know the exact tool name. NOT_WHEN: you know the name — just hayba_invoke it.',
    searchToolsSchema,
    async (args: { query: string; k?: number; filterPack?: string }) => {
      const r = await searchToolsHandler(args, { index });
      return withOrientation(toMcpResponse(r));
    },
  );

  server.tool(
    'hayba_pack_list',
    'List the tool packs — domain packs group one subsystem, workflow packs bundle a task across subsystems. Shows tool counts and which are loaded. USE_WHEN: you want the map of what exists. NOT_WHEN: you want a specific capability — hayba_search_tools is faster than reading the map.',
    packListSchema,
    async () => {
      const r = await packListHandler({}, { registry });
      return withOrientation(toMcpResponse(r));
    },
  );

  server.tool(
    'hayba_pack_load',
    'Register a pack natively so its tools appear in your tool list with full schemas. This is an OPTIMISATION for repeated use, not a prerequisite: hayba_invoke already calls any tool without it. USE_WHEN: you are about to make several calls into one domain. NOT_WHEN: one-off call — just invoke it.',
    packLoadSchema,
    async (args: { name: string }) => {
      const r = await packLoadHandler(args, { registry });
      return withOrientation(toMcpResponse(r));
    },
  );

  server.tool(
    'hayba_invoke',
    'CALL ANY TOOL BY NAME, whether or not its pack is loaded — the whole catalogue is reachable through here. Pair with hayba_search_tools when you do not know the name. USE_WHEN: any call into an unloaded domain, which is most of them. NOT_WHEN: you are making many calls into one domain — hayba_pack_load gives you native schemas.',
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
      return withOrientation(toMcpResponse(r));
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
  // Only the bootstrap set is registered here. Everything else stays in the
  // captured map: findable with hayba_search_tools, callable with hayba_invoke,
  // and registrable on demand with hayba_pack_load.
  passthrough('list_tool_categories');
  passthrough('get_tool_signature');

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
        return withOrientation(toMcpResponse(status));
      },
    );
    registeredNames.add('hayba_check_ue_status');
  }


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
