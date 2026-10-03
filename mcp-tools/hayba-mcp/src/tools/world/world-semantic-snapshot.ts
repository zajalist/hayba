import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'querying loaded scene mesh hierarchy, captured geometry point-cloud tiles with actor/component/instance identities, or an observed editor-view depth capture',
  not_when: 'judging gameplay routes, streaming, GPU cost, or production budget compliance from geometry alone; view depth covers only one editor camera and tile captures cover loaded CPU mesh LODs',
};

export const schema = z.object({
  source: z.enum(['mesh', 'mesh_tile', 'view_depth']).optional().default('mesh')
    .describe('Mesh scans, captured geometry tiles, and view-depth observations have distinct provenance and IDs.'),
  section: z.enum(['overview', 'actors', 'nodes', 'clusters', 'members', 'splats', 'groups', 'pages', 'semantic', 'relations', 'points']).optional().default('overview')
    .describe('Mesh: actors/nodes/clusters/members/splats. Mesh tile: pages/semantic/relations/nodes/points. View depth: groups/points. Overview returns metadata.'),
  offset: z.number().int().min(0).max(100_000).optional().default(0),
  limit: z.number().int().min(1).max(32).optional().default(32),
  cluster_index: z.number().int().min(0).max(100_000).optional()
    .describe('Required for members; optional filter for splats. Indices are local to one scan.'),
  node_index: z.number().int().min(0).max(100_000).optional()
    .describe('Optional authored-node ancestor filter for splats.'),
  member_kind: z.enum(['nodes', 'actors']).optional().default('nodes'),
  expected_scan_id: z.string().regex(/^[0-9A-Fa-f]{8}$/).optional()
    .describe('For mesh pages, pass the previous page scan ID to refuse a changed mesh scan.'),
  group_id: z.string().max(64).regex(/^cell:-?\d+:-?\d+:-?\d+$/).optional()
    .describe('For view_depth points only, filter by a fixed world-space cell ID from the groups page. These IDs differ from the World preview’s quantile scopes.'),
  tile_id: z.string().max(96).regex(/^tile:[012]:-?\d{1,11}:-?\d{1,11}:-?\d{1,11}$/).optional()
    .describe('For mesh_tile, identify a world-space LOD tile. An uncaptured unpinned tile reports not_captured; an evicted or invalidated expected_capture_id is refused.'),
  page_id: z.number().int().min(0).max(100_000).optional()
    .describe('Required for mesh_tile nodes and points. Get available page IDs with section pages.'),
  expected_capture_id: z.string().regex(/^[0-9A-Fa-f]{32}$/).optional()
    .describe('For mesh_tile, pass the capture ID returned by world_tile_capture even on the first overview, then reuse it for all pages. The exact retained observation is queried; eviction or world changes refuse it. View depth can also use this guard.'),
}).superRefine((value, ctx) => {
  if (value.source === 'view_depth') {
    if (!['overview', 'groups', 'points'].includes(value.section))
      ctx.addIssue({ code: 'custom', path: ['section'], message: 'view_depth supports overview, groups, or points' });
    if (value.expected_scan_id || value.cluster_index !== undefined || value.node_index !== undefined ||
        value.tile_id || value.page_id !== undefined)
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'mesh filters do not apply to view_depth' });
    if (value.group_id && value.section !== 'points')
      ctx.addIssue({ code: 'custom', path: ['group_id'], message: 'group_id applies only to view_depth points' });
  } else if (value.source === 'mesh_tile') {
    if (!['overview', 'pages', 'semantic', 'relations', 'nodes', 'points'].includes(value.section))
      ctx.addIssue({ code: 'custom', path: ['section'], message: 'mesh_tile supports overview, pages, semantic, relations, nodes, or points' });
    if (!value.tile_id)
      ctx.addIssue({ code: 'custom', path: ['tile_id'], message: 'mesh_tile requires tile_id' });
    if (value.section !== 'overview' && !value.expected_capture_id)
      ctx.addIssue({ code: 'custom', path: ['expected_capture_id'], message: 'mesh_tile detail pages require expected_capture_id; use the ID from capture start or overview' });
    if ((value.section === 'nodes' || value.section === 'points') && value.page_id === undefined)
      ctx.addIssue({ code: 'custom', path: ['page_id'], message: 'page_id is required for tile nodes and points' });
    if ((value.section === 'overview' || value.section === 'pages' || value.section === 'semantic' || value.section === 'relations') && value.page_id !== undefined)
      ctx.addIssue({ code: 'custom', path: ['page_id'], message: 'page_id applies only to tile nodes and points' });
    if (value.expected_scan_id || value.cluster_index !== undefined || value.node_index !== undefined || value.group_id)
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'mesh and depth filters do not apply to mesh_tile' });
  } else {
    if (value.section === 'groups' || value.section === 'pages' || value.section === 'semantic' || value.section === 'relations' || value.section === 'points')
      ctx.addIssue({ code: 'custom', path: ['section'], message: 'mesh does not have view_depth groups or points' });
    if (value.group_id || value.expected_capture_id || value.tile_id || value.page_id !== undefined)
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'capture filters require source view_depth or mesh_tile' });
  }
});

export const worldSemanticSnapshotHandler: ToolHandler = ueTool('world_semantic_snapshot', schema);
