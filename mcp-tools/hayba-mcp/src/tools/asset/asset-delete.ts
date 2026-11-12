import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

export const meta: HaybaToolMeta = {
  // high + heavy-ops registry: DeleteAsset loads packages and can block the
  // game thread for tens of seconds on large blueprints. The old `low` (2s)
  // tier caused Timeout waiting for response to asset_delete while UE was
  // still deleting (or stuck on a modal).
  cost: 'high',
  effects: ['deletes_asset', 'modifies_project'],
  when: 'permanently deleting a content asset by object path',
  not_when: 'moving (asset_move) or renaming (asset_rename) an asset',
};

/** Strip whitespace/newlines that agents/MCP clients inject via line-wrapping
 *  (e.g. "/Game/Foo/\n        Bar.Bar"). UE object paths do not contain
 *  whitespace; leaving it in makes DoesAssetExist fail or load the wrong path. */
export function normalizeAssetPath(path: string): string {
  return path.replace(/\s+/g, '');
}

const assetPath = z
  .string()
  .min(1)
  .transform(normalizeAssetPath)
  .refine((s) => s.length > 0, { message: 'path must not be empty after stripping whitespace' });

export const schema = z
  .object({
    path: assetPath.optional().describe('Object path of one asset to delete, e.g. /Game/Foo/MF_X.MF_X'),
    paths: z
      .array(assetPath)
      .optional()
      .describe('Several assets in one call. Prefer this over looping — one call reports which ones actually went.'),
  })
  .refine((v) => (v.path && v.path.length > 0) || (v.paths && v.paths.length > 0), {
    message: 'give `path` (string) or `paths` (array of strings)',
  });

export const assetDeleteHandler: ToolHandler = ueTool('asset_delete', schema, TOOL_ALIASES.asset_delete);
