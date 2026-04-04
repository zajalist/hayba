import { z } from 'zod';
import { getNodeByClass } from '../catalog.js';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe('JSON string of the PCGEx graph to validate attribute flow'),
  strictMode: z.boolean().optional().default(false).describe('If true, also flag orphan writes'),
});

export type ValidateAttributeFlowParams = z.infer<typeof schema>;

interface FlowIssue {
  type: 'missing_attribute' | 'orphan_write';
  severity: 'error' | 'warning';
  nodeId: string;
  nodeClass: string;
  attribute: string;
  detail: string;
  suggestedFix: string;
}

interface AttributeLifecycle {
  attribute: string;
  writtenBy: string[];
  readBy: string[];
}

function topologicalSort(nodes: PCGNode[], edges: PCGEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of edges) {
    adj.get(e.fromNode)?.push(e.toNode);
    inDegree.set(e.toNode, (inDegree.get(e.toNode) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    order.push(curr);
    for (const next of (adj.get(curr) ?? [])) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return order;
}

function getNodeWrittenAttributes(node: PCGNode): string[] {
  const attrs: string[] = [];
  // Check properties for attribute outputs (OutputAttributeName, AttributeName patterns)
  for (const [key, val] of Object.entries(node.properties || {})) {
    if ((key.toLowerCase().includes('output') && key.toLowerCase().includes('attribute')) ||
        key === 'AttributeName') {
      if (typeof val === 'string' && val.length > 0 && !val.startsWith('@')) {
        attrs.push(val);
      }
    }
  }
  return attrs;
}

function getNodeReadAttributes(node: PCGNode): string[] {
  const attrs: string[] = [];
  // Check properties for attribute inputs
  // BUG-14: exclude "AttributeName" key from read detection (it's a write, not a read)
  for (const [key, val] of Object.entries(node.properties || {})) {
    if (key === 'AttributeName') continue;
    if (key.toLowerCase().includes('attribute') && !key.toLowerCase().includes('output')) {
      if (typeof val === 'string' && val.length > 0 && !val.startsWith('@')) {
        attrs.push(val);
      }
    }
  }
  return attrs;
}

export async function validateAttributeFlow(params: ValidateAttributeFlowParams) {
  const { graph: graphStr, strictMode } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }

  // BUG-15: guard against undefined nodes/edges
  const nodes = (graph as any).nodes ?? [];
  const edges = (graph as any).edges ?? [];
  const issues: FlowIssue[] = [];

  // Build ancestor map via topological sort
  const order = topologicalSort(nodes, edges);

  // Build adjacency: predecessors
  const predecessors = new Map<string, string[]>();
  for (const n of nodes) predecessors.set(n.id, []);
  for (const e of edges) {
    predecessors.get(e.toNode)?.push(e.fromNode);
  }

  // Track available attributes at each node (union of all ancestor outputs)
  const availableAt = new Map<string, Set<string>>();
  for (const n of nodes) availableAt.set(n.id, new Set());

  // Lifecycle tracking
  const allWritten = new Map<string, string[]>(); // attr -> nodeIds that write it
  const allRead = new Map<string, string[]>();     // attr -> nodeIds that read it

  for (const nodeId of order) {
    const node = nodes.find((n: PCGNode) => n.id === nodeId);
    if (!node) continue;

    // Compute available = union of all predecessor available + what each predecessor writes
    const available = new Set<string>();
    for (const predId of (predecessors.get(nodeId) ?? [])) {
      for (const a of (availableAt.get(predId) ?? [])) available.add(a);
      const predNode = nodes.find((n: PCGNode) => n.id === predId);
      if (predNode) {
        for (const a of getNodeWrittenAttributes(predNode)) available.add(a);
      }
    }

    // Check reads (before adding own writes)
    const reads = getNodeReadAttributes(node);
    for (const attr of reads) {
      if (!available.has(attr)) {
        issues.push({
          type: 'missing_attribute',
          severity: 'error',
          nodeId: node.id,
          nodeClass: node.class,
          attribute: attr,
          detail: `Node "${node.label || node.class}" reads attribute "${attr}" but it is not written by any upstream node`,
          suggestedFix: `Add an attribute writer node upstream that outputs "${attr}", or correct the attribute name`,
        });
      }
      allRead.set(attr, [...(allRead.get(attr) ?? []), nodeId]);
    }

    // Record writes and add them to available so direct successors see them
    // BUG-13: own writes must be included in availableAt for this node
    const writes = getNodeWrittenAttributes(node);
    for (const attr of writes) {
      allWritten.set(attr, [...(allWritten.get(attr) ?? []), nodeId]);
      available.add(attr);
    }
    availableAt.set(nodeId, available);
  }

  // BUG-12: cycle detection — if topo order didn't include all nodes, there's a cycle
  if (order.length !== nodes.length) {
    issues.push({
      type: 'missing_attribute',
      severity: 'error',
      nodeId: '',
      nodeClass: '',
      attribute: '',
      detail: `Graph contains a cycle — ${nodes.length - order.length} node(s) were excluded from topological order`,
      suggestedFix: 'Remove cyclic edges to make the graph a DAG',
    });
  }

  // Orphan writes (strictMode)
  if (strictMode) {
    for (const [attr, writers] of allWritten) {
      if (!allRead.has(attr)) {
        for (const nodeId of writers) {
          const node = nodes.find((n: PCGNode) => n.id === nodeId);
          issues.push({
            type: 'orphan_write',
            severity: 'warning',
            nodeId,
            nodeClass: node?.class ?? '',
            attribute: attr,
            detail: `Attribute "${attr}" is written by "${node?.label || nodeId}" but never consumed downstream`,
            suggestedFix: `Remove the attribute writer or add a downstream node that consumes "${attr}"`,
          });
        }
      }
    }
  }

  // Build lifecycle summary
  const allAttrs = new Set([...allWritten.keys(), ...allRead.keys()]);
  const attributeLifecycle: AttributeLifecycle[] = [];
  for (const attr of allAttrs) {
    attributeLifecycle.push({
      attribute: attr,
      writtenBy: allWritten.get(attr) ?? [],
      readBy: allRead.get(attr) ?? [],
    });
  }

  return {
    valid: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    attributeLifecycle,
  };
}
