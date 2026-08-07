import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'tailing recent log lines from the UE editor (e.g. during PIE) — caller pages by tracking since_line in their own state',
  not_when: 'you need a one-shot snapshot — use editor_get_output_log instead',
};

export const schema = z.object({
  filter: z.string().optional(),
  since_line: z.number().int().nonnegative().optional(),
});

export const editorStreamLogHandler: ToolHandler = ueTool('editor_stream_log', schema);
