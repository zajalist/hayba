import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getActiveBrainConnector, type BrainConnector, type RouteIntent, type RouteMode } from '../../brain/brain-connector.js';
import { isToolDisabled } from '../disabled-tools-watcher.js';
import type { CapturedTool } from './register.js';

const intents = ['inspect_scene', 'new_scene', 'refine_scene', 'debug_level', 'pcg_build', 'material_edit', 'asset_search', 'custom_python', 'unknown'] as const;
const modes = ['explore', 'draft', 'production'] as const;
export const suggestRouteSchema = { intent: z.enum(intents), mode: z.enum(modes) };

type Candidate = { kind: 'tool' | 'workflow_skill'; id: string };
const profiles: Record<RouteIntent, readonly Candidate[]> = {
  inspect_scene: [tool('editor_get_state'), tool('actor_list'), tool('scene_export')],
  new_scene: [skill('hayba-new-scene'), tool('editor_get_state'), tool('actor_spawn'), tool('scene_export')],
  refine_scene: [skill('hayba-refine-scene'), tool('actor_list'), tool('actor_transform'), tool('material_get_info')],
  debug_level: [skill('hayba-debug-level'), tool('editor_stream_log'), tool('scene_validate_physics'), tool('validator_run')],
  pcg_build: [skill('hayba-pcg-build'), tool('hayba_search_node_catalog'), tool('hayba_get_node_details'), tool('hayba_validate_pcg_graph'), tool('hayba_create_pcg_graph')],
  material_edit: [tool('material_get_info'), tool('material_add_node'), tool('material_validate'), tool('material_compile')],
  asset_search: [tool('hayba_asset_search')],
  custom_python: [],
  unknown: [],
};
const readOnly = new Set([
  'editor_get_state', 'actor_list', 'scene_export', 'material_get_info',
  'editor_stream_log', 'scene_validate_physics', 'validator_run',
  'hayba_search_node_catalog', 'hayba_get_node_details', 'hayba_validate_pcg_graph',
  'hayba_asset_search',
]);
const workflowRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../addons/workflows');
function tool(id: string): Candidate { return { kind: 'tool', id }; }
function skill(id: string): Candidate { return { kind: 'workflow_skill', id }; }

export interface SuggestRouteDeps {
  captured: ReadonlyMap<string, CapturedTool>;
  disabled?: (name: string) => boolean;
  workflowExists?: (id: string) => boolean;
  connector?: BrainConnector | null;
}

/** A fixed catalogue suggestion. It never dispatches a tool or reads project state. */
export async function suggestRoute(
  intent: RouteIntent, mode: RouteMode, remote: boolean, deps: SuggestRouteDeps,
) {
  const disabled = deps.disabled ?? isToolDisabled;
  const workflowExists = deps.workflowExists ?? ((id: string) => existsSync(resolve(workflowRoot, id, 'SKILL.md')));
  const candidates = profiles[intent].filter((candidate) => {
    if (candidate.kind === 'tool') return deps.captured.has(candidate.id)
      && !disabled(candidate.id) && (mode !== 'explore' || readOnly.has(candidate.id));
    return mode !== 'explore' && !disabled(candidate.id) && workflowExists(candidate.id);
  }).slice(0, 5);

  let preferredId: string | null = null;
  if (remote && candidates.length > 1) {
    try {
      preferredId = await (deps.connector ?? getActiveBrainConnector())
        ?.rankRoute?.(intent, mode, candidates.map((c) => c.id)) ?? null;
    } catch {
      // Advice is optional. A failed Brain call cannot break local routing.
    }
  }
  const suggested = candidates.find((c) => c.id === preferredId) ?? candidates[0] ?? null;
  return { intent, mode, source: preferredId && suggested.id === preferredId ? 'brain' : 'local', suggested, candidates };
}

export function registerSuggestRoute(
  server: McpServer, captured: ReadonlyMap<string, CapturedTool>, mode: 'local' | 'brain',
): void {
  server.registerTool(
    'hayba_suggest_route',
    {
      description: 'Suggest a verified Hayba tool or installed local workflow skill for an abstract intent. Read-only advice; never executes, grants approval, or supplies tool arguments. Brain ranking is used only when explicitly configured and signed in.',
      inputSchema: z.strictObject(suggestRouteSchema),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ intent, mode: routeMode }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await suggestRoute(intent, routeMode, mode === 'brain', { captured })) }],
    }),
  );
}
