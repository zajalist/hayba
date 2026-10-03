import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

const fact = z.object({
  kind: z.enum(['tag', 'folder', 'actor_class', 'mesh_asset']),
  value: z.string().trim().min(1).max(512),
});

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'finding loaded Unreal source objects by authored facts and optional sampled spatial relations within one pinned World tile capture',
  not_when: 'asking for inferred gameplay labels, occlusion, navigability, streaming or GPU cost, or a complete-world absence verdict from partial geometry',
};

export const schema = z.object({
  tile_id: z.string().max(96).regex(/^tile:[012]:-?\d{1,11}:-?\d{1,11}:-?\d{1,11}$/)
    .describe('Tile ID returned by world_tile_capture.'),
  expected_capture_id: z.string().regex(/^[0-9A-Fa-f]{32}$/)
    .describe('The exact capture ID returned by world_tile_capture; never substitute a newer capture silently.'),
  target: fact.describe('Exact authored tag, folder, actor class, or mesh asset to find. This is not an inferred visual label.'),
  reference_source_node_id: z.string().trim().min(1).max(1024).optional()
    .describe('Canonical source node ID of the object used as the spatial reference.'),
  reference: fact.optional()
    .describe('Alternatively, exact authored fact selecting reference sources. The query compares matching targets to these references.'),
  relation_kind: z.enum([
    'near_sampled_bounds', 'above_sampled_bounds',
    'sampled_bounds_overlap', 'sampled_bounds_contains',
  ]).optional().describe('Provisional relation computed from sampled point bounds, not collision or visibility.'),
  near_threshold_cm: z.number().finite().min(0).max(2000).optional()
    .describe('Maximum sampled-bounds gap for near relation, in Unreal centimeters.'),
  above_minimum_gap_cm: z.number().finite().min(0).max(1000).optional(),
  above_maximum_gap_cm: z.number().finite().min(0).max(5000).optional(),
  offset: z.number().int().min(0).max(100_000).optional().default(0),
  limit: z.number().int().min(1).max(32).optional().default(32),
}).superRefine((value, ctx) => {
  const referenceCount = Number(Boolean(value.reference)) + Number(Boolean(value.reference_source_node_id));
  if (referenceCount > 1)
    ctx.addIssue({ code: 'custom', path: ['reference'], message: 'choose one reference source ID or authored fact' });
  if (Boolean(value.relation_kind) !== (referenceCount === 1))
    ctx.addIssue({ code: 'custom', path: ['relation_kind'], message: 'a spatial relation requires exactly one reference; omit both for a fact-only query' });
  if (value.above_minimum_gap_cm !== undefined && value.above_maximum_gap_cm !== undefined &&
      value.above_minimum_gap_cm > value.above_maximum_gap_cm)
    ctx.addIssue({ code: 'custom', path: ['above_maximum_gap_cm'], message: 'above maximum gap must be at least the minimum' });
});

export const worldQueryHandler: ToolHandler = ueTool('world_query', schema);
