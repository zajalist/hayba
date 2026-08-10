import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'turning a live PIE actor, component or world position into exact viewport and absolute desktop coordinates for headless mouse input',
  not_when: 'guessing a pixel from a screenshot or projecting an editor-world object outside PIE',
};

export const schema = z
  .object({
    pie_instance: z
      .number()
      .int()
      .min(0)
      .max(1024)
      .optional()
      .describe('Select a PIE client from available_worlds when more than one owns a viewport.'),
    actor_path: z.string().min(1).max(2048).optional(),
    actor_id: z.string().min(1).max(2048).optional(),
    actor_label: z.string().min(1).max(2048).optional(),
    world_location: z
      .tuple([
        z.number().finite().min(-1_000_000_000).max(1_000_000_000),
        z.number().finite().min(-1_000_000_000).max(1_000_000_000),
        z.number().finite().min(-1_000_000_000).max(1_000_000_000),
      ])
      .optional(),
    component_name: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Owned scene-component name/path. Requires an actor target.'),
    sample: z
      .enum(['actor_location', 'component_location', 'bounds_origin'])
      .optional()
      .describe(
        'Defaults to bounds_origin. component_location requires component_name; actor_location requires an actor without component_name.',
      ),
    player_index: z
      .number()
      .int()
      .min(0)
      .max(16)
      .optional()
      .default(0)
      .describe('Local player ordinal inside the selected PIE world.'),
    trace_visibility: z
      .boolean()
      .optional()
      .default(true)
      .describe('Hit-test the Visibility channel at the projected point and report the first actor/component.'),
  })
  .strict()
  .superRefine((value, context) => {
    const actorRefs = [value.actor_path, value.actor_id, value.actor_label].filter(
      (entry) => entry !== undefined,
    ).length;
    if (value.world_location !== undefined) {
      if (actorRefs !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'world_location is mutually exclusive with actor references',
        });
      }
      if (value.component_name !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'component_name requires an actor target' });
      }
      if (value.sample !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sample is not used with an explicit world_location',
        });
      }
    } else if (actorRefs !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass world_location or exactly one of actor_path, actor_id, or actor_label',
      });
    }
    if (value.component_name !== undefined && value.sample === 'actor_location') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'actor_location cannot be combined with component_name',
      });
    }
    if (value.component_name === undefined && value.sample === 'component_location') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'component_location requires component_name' });
    }
  });

export const pieProjectWorldHandler: ToolHandler = ueTool('editor_pie_project_world', schema);
