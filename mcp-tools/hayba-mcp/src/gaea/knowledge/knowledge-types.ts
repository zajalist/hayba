// Stub — types were extracted when the Gaea knowledge system was refactored.
// Retained here so dependent files compile without modification.

export interface NodeReference {
  name?: string;
  description: string;
  typical_predecessors: string[];
  typical_successors: string[];
  phase_hint: string;
  ports: { in: readonly string[]; out: readonly string[] };
  category?: string;
  parameters?: Record<string, unknown>;
  tips?: unknown[];
  zone_strategy?: string;
  position_params?: unknown[];
}

export type NodeReferenceMap = Record<string, NodeReference>;

export interface BestPractice {
  rule: string;
  category: string;
  [key: string]: unknown;
}

export interface WorkflowPattern {
  phase: string;
  description: string;
  when_to_use: string;
  [key: string]: unknown;
}
