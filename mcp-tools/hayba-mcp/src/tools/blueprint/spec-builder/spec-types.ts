// Data types of the Blueprint spec format (ported from the first consumer project's bpgraph.mjs;
// format documented in that project's specs/README.md).
// A spec that passed check() has exactly these shapes.

export type Scalar = string | number | boolean;

export interface ParamSpec {
  name: string;
  type: string;
}

export interface VariableSpec {
  name: string;
  type: string;
  default?: unknown;
}

export interface ComponentSpec {
  name: string;
  class: string;
  /** SCS component template properties (added by the Hayba port). */
  properties?: Record<string, Scalar>;
}

export interface FunctionSpec {
  name: string;
  inputs?: ParamSpec[];
  outputs?: ParamSpec[];
  pure?: boolean;
}

/** One node: exactly one kind key (see NodeKind) plus optional x, y, class, inputs. */
export type NodeSpec = Record<string, unknown>;

export interface GraphSpec {
  graph: string;
  nodes: Record<string, NodeSpec>;
  links?: Array<[string, string]>;
  defaults?: Record<string, Scalar>;
}

export interface BlueprintSpec {
  asset: string;
  create?: { parent: string };
  variables?: VariableSpec[];
  components?: ComponentSpec[];
  functions?: FunctionSpec[];
  graphs?: GraphSpec[];
  cdo_defaults?: Record<string, unknown>;
  description?: string;
  $comment?: unknown;
}

/** A spec plus where it came from (a file path, or "specs[i]"). */
export interface SpecEntry {
  file: string;
  spec: BlueprintSpec;
}

export type NodeKind =
  | 'entry' | 'result' | 'event' | 'custom_event' | 'bound_event' | 'call' | 'get' | 'set'
  | 'branch' | 'sequence' | 'select' | 'self' | 'cast' | 'create_widget' | 'timer';
