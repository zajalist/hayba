// asset_save: native C++ save (HaybaMCPAssetHandler::AssetSave). It replaced a
// python-backed tool and EditorAssetLibrary.save_asset in lane scripts. Named
// packages only: "no paths = save every dirty package" wrote other agents'
// half-built work to disk in a shared editor, so that mode is gone.

import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['writes-to-disk'],
  when: 'saving the assets you just changed (materials, Blueprints, data assets, imports) to disk',
  not_when: 'saving a level (level_save), or saving everything at once (not offered: other agents share this editor)',
};

export const schema = z.object({
  asset_paths: z
    .array(z.string().min(1))
    .min(1)
    .max(64)
    .describe('1-64 /Game/ asset paths, e.g. /Game/Project/Mat/M_Sand or /Game/Project/Mat/M_Sand.M_Sand'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Save even if the package is not dirty. Use it after edits that do not mark packages dirty (editor-Python AnimationLibrary notify tracks and events); without it those land in skipped_not_dirty and never reach disk.',
    ),
});

export const assetSaveHandler: ToolHandler = ueTool('asset_save', schema);
