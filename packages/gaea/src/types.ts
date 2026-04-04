import { z } from "zod";

export const NodeParamValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  params: z.record(NodeParamValueSchema).optional().default({})
});

export const EdgeSchema = z.object({
  from: z.string().min(1),
  fromPort: z.string().min(1),
  to: z.string().min(1),
  toPort: z.string().min(1)
});

// Refine validates edges only reference node ids that exist in the graph
export const GraphSchema = z
  .object({
    nodes: z.array(NodeSchema).min(1, "Graph must have at least one node"),
    edges: z.array(EdgeSchema)
  })
  .superRefine((g, ctx) => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const edge of g.edges) {
      if (!ids.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges"],
          message: `Edge references unknown node id: "${edge.from}"`
        });
      }
      if (!ids.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges"],
          message: `Edge references unknown node id: "${edge.to}"`
        });
      }
    }
  })
  .refine(
    (g) => new Set(g.nodes.map((n) => n.id)).size === g.nodes.length,
    { message: "Graph contains duplicate node ids" }
  )
  .refine(
    (g) => {
      // Topological sort to detect cycles
      const adj = new Map<string, string[]>();
      const inDeg = new Map<string, number>();
      for (const n of g.nodes) {
        adj.set(n.id, []);
        inDeg.set(n.id, 0);
      }
      for (const e of g.edges) {
        if (!adj.has(e.from) || !adj.has(e.to)) continue; // skip edges with unknown nodes
        adj.get(e.from)!.push(e.to);
        inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
      }
      const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
      let visited = 0;
      while (queue.length > 0) {
        const node = queue.shift()!;
        visited++;
        for (const neighbor of adj.get(node) ?? []) {
          const d = inDeg.get(neighbor)! - 1;
          inDeg.set(neighbor, d);
          if (d === 0) queue.push(neighbor);
        }
      }
      return visited === g.nodes.length;
    },
    { message: "Graph contains circular edges (cycles are not allowed)" }
  );

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;

// SwarmHost node type definition (returned by GET /nodes)
export interface SwarmNodeType {
  type: string;
  category: string;
  parameters: SwarmParameter[];
  inputs: string[];
  outputs: string[];
}

export interface SwarmParameter {
  name: string;
  type: "float" | "int" | "bool" | "string" | "enum";
  min?: number;
  max?: number;
  default: string | number | boolean;
  options?: string[]; // for enum type
}

// What SwarmHost returns for GET /graph/state
export interface GraphState {
  nodes: Array<{
    id: string;
    type: string;
    params: Record<string, string | number | boolean>;
    cookStatus: "clean" | "dirty" | "error";
  }>;
  edges: GraphEdge[];
}

// What SwarmHost returns after export
export interface ExportResult {
  heightmap: string;   // absolute file path
  normalmap?: string;
  splatmap?: string;
}

export interface TemplateMeta {
  name: string;
  description: string;
  tweakable: string[]; // param names the user can override
}
