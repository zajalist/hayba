import { z } from 'zod';
import { ensureConnected } from '../../tcp-client.js';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'finding high-poly meshes, LOD-chain gaps, or instance-count hotspots',
  not_when: 'auditing textures — use texture_audit',
};

export const schema = z.object({
  top_n: z.number().int().min(1).max(200).optional().describe('Top entries to return. Default 25.'),
  min_triangles: z.number().int().min(0).optional().describe('Minimum triangle count to include.'),
  path_prefix: z.string().optional().describe('Only audit assets whose path starts with this prefix.'),
  include_lod_issues: z.boolean().optional().describe('Flag meshes with sparse/missing LOD chains.'),
});

export const meshAuditHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('mesh_audit', parsed.data as Record<string, unknown>, 30_000);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `mesh_audit failed: ${resp.error ?? 'unknown'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `mesh_audit error: ${(e as Error).message}` }], isError: true };
  }
};
