import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import type { ToolDescriptor } from '../register-tool.js';
import { executeCommand } from '../tool-executor.js';
import { errorResult, okResult } from '../tool-result.js';
import { parseUePythonJson, type UePythonResult } from '../ue-python.js';

const schema = z.object({
  path: z.string().trim().min(1).max(4096).describe('Exact ChooserTable asset or object path; discover candidates with asset_registry_query.'),
  row_offset: z.number().int().min(0).max(2_147_483_647).default(0),
  row_limit: z.number().int().min(1).max(20).default(10),
  column_offset: z.number().int().min(0).max(2_147_483_647).default(0),
  column_limit: z.number().int().min(1).max(8).default(8),
}).strict();

const readMeta: HaybaToolMeta = {
  cost: 'medium', effects: [], pack: 'chooser',
  when: 'inspecting Chooser table decision rows, filter columns, input bindings and result assets before editing animation or gameplay selection',
  not_when: 'editing a table or validating gameplay behavior; this only reads primary rows and does not evaluate the chooser',
};

// shortcut: native getters export one property before text clipping; use a native
// bounded exporter if unusually large cell/result properties become common.
export const chooserInspectDescriptor: ToolDescriptor = {
  name: 'chooser_inspect',
  description: 'Inspect a UE5.9 Chooser table through its editor scripting API: signature, primary decision rows, columns, input bindings, result assets and cell values in Unreal text format. Requires the optional Chooser plugin. At most 20 rows × 8 columns per page; text is clipped at 512 characters with explicit flags. Empty cell text may mean empty or unavailable, not validation success. Use next_offset for each dimension; fallback and nested table contents are outside this view. USE_WHEN: inspecting animation or gameplay selection decisions. NOT_WHEN: modifying or evaluating the table.',
  cost: 'medium', returns: '{ok, path, class, scope, signature, row_count, column_count, rows[], columns[], page:{rows,columns}}; text values include truncated and empty_or_unavailable flags',
  schema: schema.shape, inputSchema: schema, meta: readMeta,
  handler: async (params) => {
    try {
      const args = schema.parse(params);
      const data = await executeCommand<UePythonResult>('chooser_inspect', args, { timeout: 30_000 });
      const result = parseUePythonJson<{ ok?: boolean; error?: string }>(data);
      if (result?.ok !== true) return errorResult(result?.error ?? 'Chooser inspection returned no result');
      return okResult(result);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  },
};
