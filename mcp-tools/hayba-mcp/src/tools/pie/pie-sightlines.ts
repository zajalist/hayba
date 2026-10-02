import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

const point = z.tuple([
  z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  z.number().finite().min(-1_000_000_000).max(1_000_000_000),
]);

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking up to 32 explicit collision sightlines from eye positions to one point in a live PIE world',
  not_when: 'inferring rendered visibility, walkability, World Partition residency, or performance',
};

export const schema = z.object({
  pie_instance: z.number().int().min(0).max(1024).optional()
    .describe('Required when more than one PIE world is live.'),
  eye_positions: z.array(point).min(1).max(32)
    .describe('Explicit world-space eye positions in cm. Each must be more than 0 and at most 10000 cm from the target.'),
  target_location: point.describe('One explicit world-space target point in cm.'),
}).strict().superRefine((value, context) => {
  for (const [index, eye] of value.eye_positions.entries()) {
    const distance = Math.hypot(
      eye[0] - value.target_location[0],
      eye[1] - value.target_location[1],
      eye[2] - value.target_location[2],
    );
    if (!Number.isFinite(distance) || distance <= 0 || distance > 10_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['eye_positions', index],
        message: 'Each eye must be more than 0 and at most 10000 cm from target_location.' });
    }
  }
});

export const pieSightlinesHandler: ToolHandler = ueTool('editor_pie_sightlines', schema);
