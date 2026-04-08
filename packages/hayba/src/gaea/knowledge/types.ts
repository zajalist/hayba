import { z } from 'zod';

export const HeuristicParameterSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  reason: z.string(),
});

export const GaeaArchetypeSchema = z.object({
  pattern_name: z.string().min(1),
  semantic_intent: z.string().min(1),
  core_topology: z.array(z.string()).min(1),
  heuristic_parameters: z.record(HeuristicParameterSchema),
  biome_tags: z.array(z.string()),
  scale_reference: z.string().nullable().default(null),
  source_video_id: z.string().nullable().default(null),
});

export type GaeaArchetype = z.infer<typeof GaeaArchetypeSchema>;

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