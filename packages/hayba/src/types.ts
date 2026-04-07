// mcp_server/src/types.ts

/** A pin on a PCGEx node */
export interface NodePin {
  pin: string;
  type: string;
  required?: boolean;
  description?: string;
}

/** A property on a PCGEx node */
export interface NodeProperty {
  name: string;
  type: string;
  default?: string;
  description?: string;
  enum_values?: string[];
}

/** A node in the curated catalog */
export interface CatalogNode {
  class: string;
  category: string;
  description: string;
  inputs: NodePin[];
  outputs: NodePin[];
  key_properties: NodeProperty[];
  common_patterns: string[];
}

/** The full node catalog */
export interface NodeCatalog {
  version: string;
  categories: string[];
  nodes: CatalogNode[];
}

/** A node in a PCGEx graph JSON (v2) */
export interface PCGNode {
  id: string;
  class: string;
  label: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
  customData: Record<string, unknown>;
}

/** An edge connecting two nodes */
export interface PCGEdge {
  fromNode: string;
  fromPin: string;
  toNode: string;
  toPin: string;
}

/** Full PCGEx graph JSON schema v2 */
export interface PCGGraphJSON {
  version: string;
  meta: {
    sourceGraph: string;
    ueVersion: string;
    pcgExVersion?: string;
    exportedAt: string;
    tags: string[];
  };
  nodes: PCGNode[];
  edges: PCGEdge[];
  metadata: {
    inputSettings: Record<string, unknown>;
    outputSettings: Record<string, unknown>;
    graphSettings: Record<string, unknown>;
  };
}

/** Validation error from UE */
export interface ValidationError {
  type: string;
  node: string;
  pin: string;
  detail: string;
}

/** UE status response */
export interface UEStatus {
  status: string;
  ueVersion: string;
  plugin: string;
  pluginVersion: string;
}

/** Asset listing entry */
export interface PCGAssetInfo {
  name: string;
  path: string;
  nodeCount?: number;
  edgeCount?: number;
}
