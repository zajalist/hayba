import { z } from 'zod';

export const NodeReferenceSchema = z.object({
  category: z.string(),
  description: z.string(),
  ports: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
  }),
  parameters: z.record(z.object({
    type: z.string(),
    default: z.string(),
    range: z.string().optional(),
  })),
  tips: z.array(z.string()),
  phase_hint: z.string(),
  typical_predecessors: z.array(z.string()),
  typical_successors: z.array(z.string()),
  zone_strategy: z.enum(['position', 'mask', 'none']).default('none'),
  position_params: z.array(z.string()).default([]),
});

export type NodeReference = z.infer<typeof NodeReferenceSchema>;
export type NodeReferenceMap = Record<string, NodeReference>;

export const BestPracticeSchema = z.object({
  id: z.string().optional(),
  category: z.string(),
  rule: z.string(),
  source: z.string().optional(),
});

export type BestPractice = z.infer<typeof BestPracticeSchema>;

export const WorkflowPatternSchema = z.object({
  nodes: z.array(z.string()),
  connections: z.array(z.object({
    from: z.string(),
    fromPort: z.string(),
    to: z.string(),
    toPort: z.string(),
  })),
  description: z.string(),
  when_to_use: z.string(),
  phase: z.string(),
});

export type WorkflowPattern = z.infer<typeof WorkflowPatternSchema>;
