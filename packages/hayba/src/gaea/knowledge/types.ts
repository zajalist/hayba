import { z } from 'zod';

export const HeuristicParameterSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  reason: z.string(),
});

export const PhaseSchema = z.enum(['base', 'character', 'simulation', 'lookdev', 'utility']);

export const ArchetypeGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const ArchetypeGraphEdgeSchema = z.object({
  from: z.string().min(1),
  fromPort: z.string().min(1),
  to: z.string().min(1),
  toPort: z.string().min(1),
});

export const ArchetypeGraphSchema = z.object({
  nodes: z.array(ArchetypeGraphNodeSchema).min(1),
  edges: z.array(ArchetypeGraphEdgeSchema),
});

export const ArchetypeSourceSchema = z.object({
  type: z.enum(['terrain_file', 'transcript', 'forum', 'blog']),
  name: z.string().optional(),
  video_id: z.string().optional(),
  timestamp: z.number().optional(),
});

export const GaeaArchetypeSchema = z.object({
  pattern_name: z.string().min(1),
  phase: PhaseSchema.default('character'),
  semantic_intent: z.string().min(1),
  core_topology: z.array(z.string()).min(1),
  heuristic_parameters: z.record(HeuristicParameterSchema),
  biome_tags: z.array(z.string()),
  scale_reference: z.string().nullable().default(null),
  source_video_id: z.string().nullable().default(null),
  graph: ArchetypeGraphSchema.optional(),
  node_reasoning: z.record(z.string()).default({}),
  common_mistakes: z.array(z.string()).default([]),
  sources: z.array(ArchetypeSourceSchema).default([]),
});

export type GaeaArchetype = z.infer<typeof GaeaArchetypeSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type ArchetypeGraph = z.infer<typeof ArchetypeGraphSchema>;
export type ArchetypeSource = z.infer<typeof ArchetypeSourceSchema>;

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  biome_tags: z.array(z.string()).optional(),
  topology_filter: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(3),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export const FullArchetypeGraphResponseSchema = z.object({
  pattern_name: z.string(),
  full_graph_json: z.record(z.unknown()),
  node_positions: z.record(z.object({ x: z.number(), y: z.number() })).nullable().default(null),
});

export type FullArchetypeGraphResponse = z.infer<typeof FullArchetypeGraphResponseSchema>;