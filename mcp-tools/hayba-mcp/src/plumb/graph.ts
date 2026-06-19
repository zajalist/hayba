// Constraint graph: the serialized form the UE node editor authors and the AI
// emits. A graph is a CLOSED, typed node set; it compiles down to the flat
// Constraint[] the shipped evaluator runs (graph = source of truth, flat =
// compiled artifact). No operators, no branches — the same fill-values-only
// guarantee as the primitive set, expressed as nodes.

import type { Constraint, ConstraintBinding } from './contracts.js';

export type GraphNode =
  | { id: string; kind: 'mask'; maskId: string }
  | { id: string; kind: 'geometry' }
  | { id: string; kind: 'primitive'; primitive: string; params?: Record<string, unknown>; hard?: boolean; note?: string }
  | { id: string; kind: 'gate' }
  | { id: string; kind: 'verdict' };

export interface GraphEdge { from: string; to: string; }

export interface ConstraintGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

/** Compile a graph to flat Constraints: one per primitive node. A mask edge
 *  into a primitive node sets params.mask = that mask's id. */
export function compileGraph(graph: ConstraintGraph, binding: ConstraintBinding): Constraint[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out: Constraint[] = [];
  let i = 0;
  for (const node of graph.nodes) {
    if (node.kind !== 'primitive') continue;
    const params: Record<string, unknown> = { ...(node.params ?? {}) };
    // find a mask edge feeding this primitive node
    for (const e of graph.edges) {
      if (e.to !== node.id) continue;
      const src = byId.get(e.from);
      if (src?.kind === 'mask') params.mask = src.maskId;
    }
    out.push({ id: `${node.id}#${i++}`, primitive: node.primitive, params, binding, hard: node.hard, note: node.note });
  }
  return out;
}

/** Migration: wrap each flat constraint as a primitive node fed by one geometry
 *  node, all flowing to a single verdict. */
export function constraintsToGraph(constraints: Constraint[]): ConstraintGraph {
  const nodes: GraphNode[] = [{ id: 'geom', kind: 'geometry' }, { id: 'verdict', kind: 'verdict' }];
  const edges: GraphEdge[] = [];
  constraints.forEach((c, i) => {
    const nid = `p${i}`;
    nodes.push({ id: nid, kind: 'primitive', primitive: c.primitive, params: c.params, hard: c.hard, note: c.note });
    edges.push({ from: 'geom', to: nid });
    edges.push({ from: nid, to: 'verdict' });
  });
  return { nodes, edges };
}
