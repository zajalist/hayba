import { z } from 'zod';

export const ResourceRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1).optional(),
}).strict();

export const DirectionalVerdictSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  direction: z.enum(['proceed', 'review', 'block']),
}).strict();
