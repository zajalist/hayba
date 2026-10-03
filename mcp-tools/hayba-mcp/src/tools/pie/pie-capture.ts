import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const startMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'starting a bounded, asynchronous observed editor ticker interval sample while an unambiguous PIE world is already running',
  not_when: 'measuring PIE-only, GPU, individual actor, or NPC AI cost',
};

export const getMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'polling a PIE capture id for progress, completion, or PIE lifecycle abort while the editor is safe',
  not_when: 'making a performance pass/fail decision from whole-editor timings',
};

export const startSchema = z.object({
  pie_instance: z.number().int().min(0).max(1024).optional()
    .describe('Required when more than one PIE world is running.'),
  sample_frames: z.number().int().min(1).max(600).optional().default(120),
  warmup_frames: z.number().int().min(0).max(120).optional().default(0),
  actor_tag: z.string().min(1).max(64).optional()
    .describe('Optional exact actor tag to count in one capped scan at capture completion.'),
}).strict();

export const getSchema = z.object({
  capture_id: z.string().min(1).max(64),
}).strict();

export const pieCaptureStartHandler: ToolHandler = ueTool('editor_pie_capture_start', startSchema);
export const pieCaptureGetHandler: ToolHandler = ueTool('editor_pie_capture_get', getSchema);
