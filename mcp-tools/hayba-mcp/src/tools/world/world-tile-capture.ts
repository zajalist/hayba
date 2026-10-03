import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'capturing a bounded, loaded-editor CPU mesh tile by canonical tile ID or world position, polling its progress, or cancelling it before reading pages with world_semantic_snapshot',
  not_when:
    'requesting unloaded World Partition cells, a camera image, materials, runtime cost, or a visual-quality verdict',
};

const coordinateCm = z.number().finite().min(-100_000_000).max(100_000_000);

export const schema = z
  .object({
    action: z
      .enum(['start', 'status', 'cancel'])
      .describe('Start a loaded-world tile capture, poll its capture ID, or cancel queued/in-progress work.'),
    tile_id: z
      .string()
      .max(96)
      .regex(/^tile:[012]:-?\d{1,11}:-?\d{1,11}:-?\d{1,11}$/)
      .optional()
      .describe(
        'Canonical World tile address tile:LOD:X:Y:Z, e.g. tile:2:-1:3:0. Tile edges are 4000 cm at LOD 0, 2000 cm at LOD 1, and 1000 cm at LOD 2. Start accepts this or position_cm with lod. Status/cancel may use this or capture_id.',
      ),
    position_cm: z
      .object({
        x: coordinateCm,
        y: coordinateCm,
        z: coordinateCm,
      })
      .strict()
      .optional()
      .describe(
        'World-space point in centimeters for start. Each finite axis must be within ±100,000,000 cm. With lod, the containing tile index is floor(position_cm / (4000 / (1 << lod))) on each axis, including negative positions.',
      ),
    lod: z
      .number()
      .int()
      .min(0)
      .max(2)
      .optional()
      .describe(
        'Required with position_cm for start: 0 = 4000 cm tiles, 1 = 2000 cm, 2 = 1000 cm. Do not combine with tile_id.',
      ),
    capture_id: z
      .string()
      .regex(/^[0-9A-Fa-f]{32}$/)
      .optional()
      .describe(
        'ID returned by start. Use for status/cancel to follow that exact request. For snapshot pages, pass it as expected_capture_id to pin the captured observation and detect world changes or eviction.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'start') {
      if (value.capture_id !== undefined)
        ctx.addIssue({ code: 'custom', path: ['capture_id'], message: 'start cannot use capture_id' });
      if ((value.tile_id !== undefined) === (value.position_cm !== undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['tile_id'],
          message: 'start requires exactly one of tile_id or position_cm with lod',
        });
      if ((value.position_cm !== undefined) !== (value.lod !== undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['lod'],
          message: 'position_cm and lod must be provided together for start',
        });
    } else {
      if ((value.tile_id !== undefined) === (value.capture_id !== undefined))
        ctx.addIssue({
          code: 'custom',
          path: ['capture_id'],
          message: 'status and cancel require exactly one of capture_id or tile_id',
        });
      if (value.position_cm !== undefined || value.lod !== undefined)
        ctx.addIssue({ code: 'custom', path: ['position_cm'], message: 'position_cm and lod apply only to start' });
    }
  });

export const worldTileCaptureHandler: ToolHandler = ueTool('world_tile_capture', schema);
