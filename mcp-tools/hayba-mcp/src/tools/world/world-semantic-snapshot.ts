import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'understanding the loaded scene through mesh-derived spatial clusters and the actual level, folder, actor, component, and instance hierarchy',
  not_when: 'judging visual quality, gameplay routes, streaming, GPU cost, or production budget compliance from geometry alone',
};

export const schema = z.object({
  section: z.enum(['overview', 'actors', 'nodes', 'clusters', 'members', 'splats']).optional().default('overview')
    .describe('Read a bounded page of one scene table. Overview returns counts and coverage without arrays.'),
  offset: z.number().int().min(0).max(100_000).optional().default(0),
  limit: z.number().int().min(1).max(32).optional().default(32),
  cluster_index: z.number().int().min(0).max(100_000).optional()
    .describe('Required for members; optional filter for splats. Indices are local to one scan.'),
  node_index: z.number().int().min(0).max(100_000).optional()
    .describe('Optional authored-node ancestor filter for splats.'),
  member_kind: z.enum(['nodes', 'actors']).optional().default('nodes'),
  expected_scan_id: z.string().regex(/^[0-9A-Fa-f]{8}$/).optional()
    .describe('Pass the previous page scan ID to refuse a changed scene while paging.'),
});

export const worldSemanticSnapshotHandler: ToolHandler = ueTool('world_semantic_snapshot', schema);
