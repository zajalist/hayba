import { z } from 'zod';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { executeCommand } from './tool-executor.js';
import { errorResult } from './tool-result.js';

const artifactFilename = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^<>:"/\\|?*\u0000-\u001f]+$/, 'must be a clean filename without path separators or reserved characters')
  .refine((name) => name !== '.' && name !== '..' && !/[. ]$/.test(name), 'must name a safe file')
  .refine(
    (name) => !/^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\s*\.|$)/i.test(name),
    'must not use a reserved Windows device name',
  );

export const schema = z
  .object({
    camera: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('actor'),
        actor: z.string().describe('Full actor path, e.g. /Game/Maps/L1.L1:PersistentLevel.HeroCamera'),
      }),
      z.object({
        kind: z.literal('transform'),
        location: z.tuple([z.number(), z.number(), z.number()]),
        rotation: z.tuple([z.number(), z.number(), z.number()]).describe('[pitch, yaw, roll] in UE order'),
        fov: z.number().min(5).max(170).optional().default(90),
      }),
    ]),
    output_path: artifactFilename
      .optional()
      .describe(
        'Optional clean filename only (no path). Written without overwrite under Saved/Screenshots/Hayba; omit for a unique name.',
      ),
    width: z.number().int().min(64).max(4096).optional().default(1920),
    height: z.number().int().min(64).max(4096).optional().default(1080),
    format: z.enum(['png', 'jpg']).optional().default('png'),
    wait_for_subsystems: z
      .array(z.enum(['shaders', 'assets', 'gc', 'pcg', 'world_tick']))
      .optional()
      .default(['shaders', 'assets', 'world_tick']),
    wait_timeout_s: z.number().int().min(0).max(60).optional().default(30),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'render_camera is a known editor-crasher; it refuses unless force:true. Prefer set_level_viewport_camera_info + editor_capture_viewport (which now returns a real image block).',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.width * value.height > 8 * 1024 * 1024) {
      ctx.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'width*height exceeds the 8,388,608-pixel render/readback budget',
      });
    }
    if (value.output_path !== undefined && !value.output_path.toLowerCase().endsWith(`.${value.format}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['output_path'],
        message: `filename extension must be .${value.format}`,
      });
    }
  });

export type RenderCameraParams = z.infer<typeof schema>;

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write'],
  when: 'You need to see what the level looks like from a camera. Returns a disk path you read separately if you need pixels.',
  not_when: 'Pure metadata read — no scene change to visualize.',
};

export async function handleRenderCamera(params: RenderCameraParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return errorResult('Invalid params: ' + parsed.error.message);
  }
  if (!parsed.data.force) {
    return errorResult(
      [
        'Blocked: render_camera is a known editor-crasher.',
        'Safe alternative: set the viewport camera with set_level_viewport_camera_info, then call editor_capture_viewport (it now returns a real inline image block).',
        'If you are certain and accept the risk, re-run with force:true.',
      ].join('\n'),
    );
  }
  const data = await executeCommand('render_camera', parsed.data as Record<string, unknown>, {
    timeout: (parsed.data.wait_timeout_s + 30) * 1000,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
