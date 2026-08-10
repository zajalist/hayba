import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_world_input'],
  when: 'clicking an exact live PIE actor without moving the desktop cursor or foregrounding the PIE window',
  not_when:
    'hovering world actors (no public UE route can preserve native hover state while guaranteeing zero OS cursor movement), the PIE viewport is hidden/minimized/absent, clicking Slate/UMG controls (use editor_pie_click_widget), or targeting an unverified screen coordinate (use editor_pie_project_world first to diagnose it)',
};

export const schema = z
  .object({
    pie_instance: z
      .number()
      .int()
      .min(0)
      .max(1024)
      .optional()
      .describe('Required when more than one PIE client owns a viewport.'),
    actor_path: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Exact path returned by editor_pie_actor_list; safest and unambiguous.'),
    actor_id: z.string().min(1).max(2048).optional(),
    actor_label: z.string().min(1).max(2048).optional(),
    component_name: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe('Require this owned primitive component to be the first Visibility hit.'),
    sample: z
      .enum(['actor_location', 'component_location', 'bounds_origin'])
      .optional()
      .describe(
        'Point to project before verifying the first Visibility hit. Defaults to bounds_origin; component_location requires component_name.',
      ),
    player_index: z
      .number()
      .int()
      .min(0)
      .max(16)
      .optional()
      .default(0)
      .describe('Local player ordinal inside the selected PIE world.'),
    action: z
      .literal('click')
      .optional()
      .default('click')
      .describe(
        'Synchronously dispatches the exact guarded native primitive stage used by APlayerController. Hover is deliberately unsupported because UE exposes no public zero-OS-cursor route to its protected hover state.',
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const actorRefs = [value.actor_path, value.actor_id, value.actor_label].filter(
      (entry) => entry !== undefined,
    ).length;
    if (actorRefs !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pass exactly one of actor_path, actor_id, or actor_label',
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

export const pieClickActorHandler: ToolHandler = ueTool('editor_pie_click_actor', schema);
