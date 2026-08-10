import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading the transform, bounds, tags and owned components of one actor in the live PIE world',
  not_when: 'editing an actor or inspecting an editor-world actor outside PIE',
};

const actorReference = {
  actor_path: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('Exact path returned by editor_pie_actor_list; safest and unambiguous.'),
  actor_id: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('Runtime object name; rejected if it matches more than one actor.'),
  actor_label: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('Editor label; rejected if it matches more than one actor.'),
};

export const schema = z
  .object({
    pie_instance: z.number().int().min(0).max(1024).optional(),
    ...actorReference,
    component_filter: z.string().max(256).optional().describe('Case-insensitive substring of component name or class.'),
    component_offset: z.number().int().min(0).max(1_000_000).optional().default(0),
    component_limit: z.number().int().min(1).max(50).optional().default(50),
  })
  .strict()
  .superRefine((value, context) => {
    const supplied = [value.actor_path, value.actor_id, value.actor_label].filter(
      (entry) => entry !== undefined,
    ).length;
    if (supplied !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass exactly one of actor_path, actor_id, or actor_label',
      });
    }
  });

export const pieActorInspectHandler: ToolHandler = ueTool('editor_pie_actor_inspect', schema);
