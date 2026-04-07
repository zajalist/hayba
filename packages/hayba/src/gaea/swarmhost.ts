import * as cp from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { SwarmNodeType, SwarmParameter, GraphState, GraphEdge, ExportResult, Graph } from "./types.js";
import { detectSwarmPath, GAEA_SWARM_CANDIDATE_PATHS } from "./gaea-launcher.js";

// ─── Public config interface ──────────────────────────────────────────────────

export interface SwarmHostConfig {
  execPath: string;  // path to Gaea.BuildManager.exe
  port: number;      // kept for back-compat; unused in CLI mode
  outputDir: string; // build output directory
  gaeaExePath?: string; // optional path to Gaea.exe for launching the UI
  swarmExePath?: string; // optional path to Gaea.Swarm.exe for CLI cooking
}

// ─── Internal terrain-file types ─────────────────────────────────────────────

interface TerrainPort {
  Name: string;
  Type: string;
  Record?: {
    "$id"?: string;
    From: number;
    To: number;
    FromPort: string;
    ToPort: string;
    IsValid: boolean;
  };
  IsExporting: boolean;
  [key: string]: unknown;
}

interface TerrainNode {
  $type: string;
  Id: number;
  Name: string;
  Position: { X: number; Y: number };
  Ports: TerrainPort[] | { "$id": string; "$values": TerrainPort[] };
  Modifiers: unknown[] | { "$id": string; "$values": unknown[] };
  [key: string]: unknown;
}

interface TerrainFile {
  Assets: Array<{
    Terrain: {
      Id: string;
      Metadata: Record<string, unknown>;
      Nodes: Record<string, TerrainNode>;
      Groups: Record<string, unknown>;
      Notes: Record<string, unknown>;
      GraphTabs: unknown[];
      Width: number;
      Height: number;
      Ratio: number;
      Regions: unknown[];
    };
    Automation: {
      Bindings: unknown[];
      Expressions: Record<string, unknown>;
      Variables: Record<string, unknown>;
    };
    BuildDefinition: {
      Type: string;
      Destination: string;
      Resolution: number;
      BakeResolution: number;
      TileResolution: number;
      BucketResolution: number;
      NumberOfTiles: number;
      EdgeBlending: number;
      TileZeroIndex: boolean;
      TilePattern: string;
      OrganizeFiles: string;
      PostBuildScript: string;
      ColorSpace: string;
    };
    State: Record<string, unknown>;
    BuildProfiles: Record<string, unknown>;
  }>;
  Id: string;
  Branch: number;
  Metadata: Record<string, unknown>;
}

// ─── Gaea C# enum definitions (reflected from Gaea.Nodes.dll) ────────────────
// These are the ONLY valid string values Gaea will accept for enum parameters.
// Passing any other string causes a JsonSerializationException that corrupts the load.

const GAEA_ENUMS: Record<string, string[]> = {
  MountainStyle:       ["Basic", "Eroded", "Old", "Alpine", "Strata"],
  MountainBulk:        ["Low", "Medium", "High"],
  MountainRangeStyle:  ["Basic", "Eroded", "Stratified", "Alpine"],
  QuickErosion:        ["Simple", "Ancient", "Ancient2", "Alpine", "Rocky", "Exposed", "Flows", "Flows2", "Flows3", "Strata", "Withered", "SoftSoil", "SoftSoil2", "Dessicated", "Thin"],
  BlendMode:           ["Blend", "Add", "Screen", "Subtract", "Difference", "Multiply", "Divide", "Divide2", "Max", "Min", "Hypotenuse", "Overlay", "Power", "Exclusion", "Dodge", "Burn", "SoftLight", "HardLight", "PinLight", "GrainMerge", "GrainExtract", "Reflect", "Glow", "Phoenix"],
  CanyonStyle:         ["Classic", "Eroded", "Eroded2", "Strata", "Both"],
  CraterStyle:         ["New", "Classic"],
  FoldWaveform:        ["Sine", "Triangle", "Sawtooth"],
  MeltType:            ["Uniform", "Directional"],
  MultifractalNoiseType: ["FBM", "Billowy", "Ridged"],
  PerlinNoiseType:     ["FBM", "Ridged", "Billowy"],
  NoiseType:           ["Value", "ValueFractal", "Perlin", "PerlinFractal", "Simplex", "SimplexFractal", "WhiteNoise", "Cellular", "Cubic", "CubicFractal"],
  Generic4:            ["Low", "Med", "High", "Ultra"],       // SatMap.Rough
  ProcessInput:        ["None", "Autolevel", "Equalize"],     // SatMap.Enhance, Combine.Enhance
  CurvatureType:       ["Horizontal", "Vertical", "Average"],
  GradientDirection:   ["X", "N", "E", "S", "W"],            // Snowfield.Direction
  LineNoiseStyle:      ["Sharp", "Soft", "Flat", "Vague"],
  DotNoiseStyle:       ["Dot", "Square"],
  TextureMapType:      ["None", "Texture", "Peaks", "Flow"],  // SuperColor.Texture
  GroundStyle:         ["Harsh", "Rocky", "Rough"],
  CrackStyle:          ["Normal", "Hard", "Classic"],
  DistanceRTStyle:     ["Asterisk", "Pyramid"],
  DistanceMode:        ["Classic", "RT"],
  ShortSharp:          ["Soft", "Sharp"],
  StratifyMode:        ["Linear", "Fractal"],
  Sedimentation:       ["Fine", "Bulky", "Classic"],
  RecurveStyle:        ["Inward", "Outward"],
  MapRenderStyle:      ["Flat", "HillShade", "Occlusion", "SoftLight"],
  QuickTexture:        ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"],
  MountainSideType:    ["Slope", "Peak"],
  RockClusters:        ["Off", "Large", "Small", "Shattered"],
  RockRelief:          ["Off", "Sharp", "Soft", "Stratified"],
  HillCoverage:        ["Moderate", "Aggressive"],
  HillSurface:         ["Smooth", "Eroded"],
  DebrisShape:         ["Rounded", "Sharp"],
};

// Map: NodeType.ParamName → enum type name
const PARAM_ENUM_MAP: Record<string, string> = {
  "Mountain.Style":        "MountainStyle",
  "Mountain.Bulk":         "MountainBulk",
  "MountainRange.Style":   "MountainRangeStyle",
  "MountainRange.Bulk":    "MountainBulk",
  "MountainSide.Style":    "MountainSideType",
  "EasyErosion.Style":     "QuickErosion",
  "Combine.Mode":          "BlendMode",
  "Combine.Enhance":       "ProcessInput",
  "Canyon.Style":          "CanyonStyle",
  "Crater.Style":          "CraterStyle",
  "Fold.Waveform":         "FoldWaveform",
  "Snow.MeltType":         "MeltType",
  "Snowfield.Direction":   "GradientDirection",
  "MultiFractal.NoiseType":"MultifractalNoiseType",
  "Noise.NoiseType":       "NoiseType",
  "Perlin.NoiseType":      "PerlinNoiseType",
  "SatMap.Enhance":        "ProcessInput",
  "SatMap.Rough":          "Generic4",
  "Curvature.Type":        "CurvatureType",
  "LineNoise.Style":       "LineNoiseStyle",
  "DotNoise.Style":        "DotNoiseStyle",
  "SuperColor.Texture":    "TextureMapType",
  "TextureBase.Enhance":   "ProcessInput",
  "Distance.Mode":         "DistanceMode",
  "Crack.Style":           "CrackStyle",
  "Stratify.Mode":         "StratifyMode",
  "RockNoise.Style":       "QuickTexture",
  "Texturizer.Style":      "QuickTexture",
};

// ─── Parameter validation: check enum values before writing to terrain ─────────

function validateAndFixParameter(nodeType: string, paramName: string, value: unknown): unknown {
  const enumTypeName = PARAM_ENUM_MAP[`${nodeType}.${paramName}`];
  if (!enumTypeName) return value; // Not a known enum parameter

  const enumValues = GAEA_ENUMS[enumTypeName];
  if (!enumValues) return value;

  const strVal = String(value);

  // Exact match
  if (enumValues.includes(strVal)) return strVal;

  // Case-insensitive match
  const match = enumValues.find(e => e.toLowerCase() === strVal.toLowerCase());
  if (match) {
    console.warn(`Parameter validation: corrected '${strVal}' to '${match}' for ${nodeType}.${paramName}`);
    return match;
  }

  // Invalid value — throw helpful error instead of corrupting the file
  throw new Error(
    `Invalid enum value '${strVal}' for ${nodeType}.${paramName} (C# enum: ${enumTypeName}). ` +
    `Valid values: ${enumValues.join(", ")}`
  );
}

// ─── Helper: normalise Ports array (real files use $values wrapper) ───────────

function getPorts(node: TerrainNode): TerrainPort[] {
  const p = node.Ports;
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object" && "$values" in p) {
    return (p as { "$values": TerrainPort[] })["$values"];
  }
  return [];
}

// ─── Helper: get Assets array regardless of JSON.NET $values wrapper ─────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAssets(terrain: any): any[] {
  const a = terrain.Assets;
  if (Array.isArray(a)) return a;
  if (a && typeof a === "object" && "$values" in a) return a["$values"] as unknown[];
  return [];
}

// ─── JSON.NET $id counter helpers ────────────────────────────────────────────

function makeIdCounter(start = 1): () => string {
  let c = start;
  return () => String(c++);
}

// ─── Custom JSON serializer: ensures $-prefixed keys always appear first ──────
//
// Gaea deserializes Nodes as Dictionary<int, TerrainNode>. Newtonsoft.Json reads
// "$id" as a metadata property only if it is the FIRST key encountered. If any
// integer key (e.g. "100") appears before "$id", JSON.NET is already in dictionary
// mode and tries to parse "$id" as System.Int32 — throwing a format exception.
// JavaScript's JSON.stringify always sorts integer-indexed keys before string keys,
// so we must use a custom serializer that puts $-prefixed keys first.

function serializeGaea(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);

  const pad    = "  ".repeat(depth);
  const inner  = "  ".repeat(depth + 1);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map(v => inner + serializeGaea(v, depth + 1)).join(",\n") + "\n" + pad + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";

  // Order: $-prefixed keys first (covers $id, $type, $values, $ref),
  // then numeric string keys sorted ascending, then remaining string keys.
  const dollarKeys = keys.filter(k => k.startsWith("$"));
  const intKeys    = keys.filter(k => !k.startsWith("$") && /^\d+$/.test(k))
                        .sort((a, b) => Number(a) - Number(b));
  const strKeys    = keys.filter(k => !k.startsWith("$") && !/^\d+$/.test(k));
  const ordered    = [...dollarKeys, ...intKeys, ...strKeys];

  const entries = ordered.map(k => inner + JSON.stringify(k) + ": " + serializeGaea(obj[k], depth + 1));
  return "{\n" + entries.join(",\n") + "\n" + pad + "}";
}

function findMaxJsonId(obj: unknown): number {
  if (obj === null || typeof obj !== "object") return 0;
  let max = 0;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "$id" && typeof v === "string") {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > max) max = n;
    } else {
      const child = findMaxJsonId(v);
      if (child > max) max = child;
    }
  }
  return max;
}

// ─── Helper: build a fresh .terrain file from our simplified graph JSON ───────

function buildTerrainFile(
  graph: { nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>; edges: Array<{ from: string; fromPort: string; to: string; toPort: string }> },
  outputDir: string
): object {
  const id = makeIdCounter(1);
  const terrainId = randomUUID();
  const shortId = terrainId.replace(/-/g, "").slice(0, 8);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ") + "Z";

  // Pre-assign sequential $ids for all wrapper objects FIRST, matching the order
  // Newtonsoft.Json would assign them: root → Assets → Asset[0] → Terrain → Metadata → Nodes
  // This prevents collisions when node $ids are assigned later in the same counter sequence.
  const ROOT_ID    = id(); // "1"
  const ASSETS_ID  = id(); // "2"
  const ASSET0_ID  = id(); // "3"
  const TERRAIN_ID = id(); // "4"
  const META_ID    = id(); // "5"
  const NODES_ID   = id(); // "6"
  // Node $ids start from "7" onwards — no collision with wrapper ids above

  // Assign stable integer IDs to named nodes
  const idMap = new Map<string, number>();
  graph.nodes.forEach((n, i) => idMap.set(n.id, 400 + i * 100));

  const hasOutput = graph.nodes.some(n => n.type === "Unreal" || n.type === "Output");
  const lastDataNode = graph.nodes[graph.nodes.length - 1];
  const exportNodeId = 900;

  // Build nodes with proper JSON.NET $id format
  const nodesEntries: Array<[string, object]> = [];
  let posX = 26650;

  for (const n of graph.nodes) {
    const intId = idMap.get(n.id)!;
    const nodeJsonId = id(); // $id for this node object — referenced by port Parents
    const incomingEdges = graph.edges.filter(e => e.to === n.id);

    // Validate all enum params before writing
    const validatedParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.params)) {
      validatedParams[k] = validateAndFixParameter(n.type, k, v);
    }

    const portValues: object[] = [];
    if (incomingEdges.length === 0) {
      portValues.push({ "$id": id(), Name: "In", Type: "PrimaryIn", IsExporting: true, Parent: { "$ref": nodeJsonId } });
    } else {
      for (const edge of incomingEdges) {
        portValues.push({
          "$id": id(),
          Name: edge.toPort || "In",
          Type: "PrimaryIn, Required",
          Record: { "$id": id(), From: idMap.get(edge.from)!, To: intId, FromPort: edge.fromPort || "Out", ToPort: edge.toPort || "In", IsValid: true },
          IsExporting: true,
          Parent: { "$ref": nodeJsonId }
        });
      }
    }
    portValues.push({ "$id": id(), Name: "Out", Type: "PrimaryOut", IsExporting: true, Parent: { "$ref": nodeJsonId } });

    nodesEntries.push([String(intId), {
      "$id": nodeJsonId,
      "$type": `QuadSpinner.Gaea.Nodes.${n.type}, Gaea.Nodes`,
      ...validatedParams,
      Id: intId,
      Name: n.id,
      Position: { "$id": id(), X: posX, Y: 26300.0 },
      Ports: { "$id": id(), "$values": portValues },
      Modifiers: { "$id": id(), "$values": [] }
    }]);
    posX += 300;
  }

  // Add Unreal export node connected to last data node
  if (!hasOutput && graph.nodes.length > 0) {
    const lastIntId = idMap.get(lastDataNode.id)!;
    const exportJsonId = id();
    nodesEntries.push([String(exportNodeId), {
      "$id": exportJsonId,
      "$type": "QuadSpinner.Gaea.Nodes.Unreal, Gaea.Nodes",
      Id: exportNodeId,
      Name: "00-Heightmap",
      PortCount: 1,
      Position: { "$id": id(), X: posX, Y: 26300.0 },
      Ports: {
        "$id": id(), "$values": [
          {
            "$id": id(), Name: "In", Type: "PrimaryIn, Required",
            Record: { "$id": id(), From: lastIntId, To: exportNodeId, FromPort: "Out", ToPort: "In", IsValid: true },
            IsExporting: true, Parent: { "$ref": exportJsonId }
          },
          { "$id": id(), Name: "Out", Type: "PrimaryOut", IsExporting: true, Parent: { "$ref": exportJsonId } }
        ]
      },
      Modifiers: { "$id": id(), "$values": [] }
    }]);
  }

  // nodesObj uses the pre-assigned NODES_ID — no collision with ROOT_ID
  const nodesObj = Object.fromEntries([["$id", NODES_ID], ...nodesEntries]);

  return {
    "$id": ROOT_ID,
    Assets: {
      "$id": ASSETS_ID, "$values": [{
        "$id": ASSET0_ID,
        Terrain: {
          "$id": TERRAIN_ID,
          Id: terrainId,
          Metadata: { "$id": META_ID, Name: "", Description: "", Version: "2.2.7.0", DateCreated: now, DateLastBuilt: now, DateLastSaved: now, ModifiedVersion: "2.2.7.0" },
          Nodes: nodesObj,
          Groups: { "$id": id() },
          Notes: { "$id": id() },
          GraphTabs: {
            "$id": id(), "$values": [{
              "$id": id(), Name: "Graph 1", Color: "Brass",
              ZoomFactor: 0.6299605249474372,
              ViewportLocation: { "$id": id(), X: 26647.016, Y: 26057.055 }
            }]
          },
          Width: 8000.0,
          Height: 4000.0,
          Ratio: 0.5,
          Regions: { "$id": id(), "$values": [] }
        },
        Automation: {
          "$id": id(),
          Bindings: { "$id": id(), "$values": [] },
          Expressions: { "$id": id() },
          VariablesEx: { "$id": id() },
          Variables: { "$id": id() }
        },
        BuildDefinition: {
          "$id": id(),
          Type: "Standard",
          Destination: outputDir,
          Resolution: 1024,
          BakeResolution: 1024,
          TileResolution: 512,
          BucketResolution: 1024,
          NumberOfTiles: 2,
          EdgeBlending: 0.25,
          TileZeroIndex: true,
          TilePattern: "_y%Y%_x%X%",
          OrganizeFiles: "NodeSubFolder"
        },
        State: {
          "$id": id(),
          BakeResolution: 1024,
          PreviewResolution: 512,
          HDResolution: 2048,
          SelectedNode: -1,
          NodeBookmarks: { "$id": id(), "$values": [] },
          Viewport: {
            "$id": id(),
            CameraPosition: { "$id": id(), "$values": [] },
            Camera: { "$id": id() },
            RenderMode: "Realistic",
            AmbientOcclusion: true,
            Shadows: true
          }
        },
        BuildProfiles: { "$id": id() }
      }]
    },
    Id: shortId,
    Branch: 1,
    Metadata: {
      "$id": id(),
      Name: "", Description: "", Version: "2.2.7.0", Owner: "",
      DateCreated: now, DateLastBuilt: now, DateLastSaved: now, ModifiedVersion: "2.2.7.0"
    }
  };
}

// ─── Helper: extract user-facing params from a node (skip structural fields) ──

const EXCLUDED_NODE_KEYS = new Set([
  "$type", "$id", "$ref", "Id", "Name", "Position", "Ports", "Modifiers",
  "NodeSize", "PortCount", "Parent", "HasUI", "Intrinsic"
]);

function getNodeParams(node: TerrainNode): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (EXCLUDED_NODE_KEYS.has(k)) continue;
    // Skip $-prefixed JSON.NET reference fields
    if (k.startsWith("$")) continue;
    // Skip arrays and reference objects (like Range which is a point struct — keep it)
    params[k] = v;
  }
  return params;
}

function getNodeParameters(node: TerrainNode): SwarmParameter[] {
  const params = getNodeParams(node);
  return Object.entries(params).map(([name, value]) => ({
    name,
    type: (typeof value === "number" ? "float" : typeof value === "boolean" ? "bool" : "string") as SwarmParameter["type"],
    default: value as string | number | boolean
  }));
}

// ─── Helper: parse graph state from a terrain file ───────────────────────────

function parseGraphState(terrain: TerrainFile): GraphState {
  const nodesMap = getAssets(terrain)[0].Terrain.Nodes as Record<string, TerrainNode>;

  const nodes = (Object.entries(nodesMap) as [string, TerrainNode][])
    .filter(([k]) => k !== "$id")
    .map(([, n]) => ({
      id: n.Name || String(n.Id),
      type: n.$type.split(".").pop()?.split(",")[0] ?? n.$type,
      params: getNodeParams(n) as Record<string, string | number | boolean>,
      cookStatus: "dirty" as const
    }));

  const edges: GraphEdge[] = [];
  for (const [k, node] of Object.entries(nodesMap) as [string, TerrainNode][]) {
    if (k === "$id") continue;
    for (const port of getPorts(node)) {
      if (port.Record) {
        const fromNode = (Object.values(nodesMap) as TerrainNode[]).find(n => n.Id === port.Record!.From);
        edges.push({
          from: fromNode?.Name || String(port.Record.From),
          fromPort: port.Record.FromPort,
          to: node.Name || String(node.Id),
          toPort: port.Record.ToPort
        });
      }
    }
  }

  return { nodes, edges };
}

// ─── Helper: scan a directory for heightmap / normalmap / splatmap files ──────

function findExportFiles(dir: string): ExportResult {
  if (!existsSync(dir)) throw new Error(`Output directory not found: ${dir}`);
  const files = readdirSync(dir) as string[];
  const heightmap = files.find(f => /heightmap|height/i.test(f) && /\.(png|exr|r16)$/i.test(f));
  const normalmap = files.find(f => /normal/i.test(f) && /\.(png|exr)$/i.test(f));
  const splatmap  = files.find(f => /splat|weight/i.test(f) && /\.(png|exr)$/i.test(f));

  if (!heightmap) {
    const any = files.find(f => /\.(png|exr|r16)$/i.test(f));
    if (!any) throw new Error(`No output image files found in ${dir}`);
    return { heightmap: path.join(dir, any) };
  }

  return {
    heightmap: path.join(dir, heightmap),
    normalmap: normalmap ? path.join(dir, normalmap) : undefined,
    splatmap:  splatmap  ? path.join(dir, splatmap)  : undefined
  };
}

// ─── Hardcoded node catalog (Gaea 2 has no live catalogue API) ────────────────

const NODE_CATALOG: SwarmNodeType[] = [
  // ── Primitives ──────────────────────────────────────────────────────────────
  {
    type: "Mountain", category: "primitives",
    parameters: [
      { name: "Seed",   type: "int",   default: 0 },
      { name: "Scale",  type: "float", min: 0.1, max: 10, default: 1.0 },
      { name: "Height", type: "float", min: 0,   max: 10, default: 0.5 },
      { name: "Style",  type: "enum",  default: "Basic", options: ["Basic", "Eroded", "Old", "Alpine", "Strata"] },
      { name: "Bulk",   type: "enum",  default: "Medium", options: ["Low", "Medium", "High"] }
    ],
    inputs: [], outputs: ["Out"]
  },
  {
    type: "MountainSide", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Scale", type: "float", min: 0.1, max: 10, default: 1.0 },
      { name: "Detail", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Style", type: "enum", default: "Slope", options: ["Slope", "Peak"] }
    ],
    inputs: [], outputs: ["Out"]
  },
  {
    type: "Ridge", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Height", type: "float", min: 0, max: 10, default: 0.5 }
    ],
    inputs: [], outputs: ["Out"]
  },
  {
    type: "Perlin", category: "primitives",
    parameters: [
      { name: "Seed",    type: "int",   default: 0 },
      { name: "Scale",   type: "float", min: 0.01, max: 10, default: 1.0 },
      { name: "Octaves", type: "int",   min: 1,    max: 16, default: 8 }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "MultiFractal", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Size", type: "float", min: 0.01, max: 10, default: 1.0 },
      { name: "NoiseType", type: "enum", default: "FBM", options: ["FBM", "Billowy", "Ridged"] }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Voronoi", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Scale", type: "float", min: 0.1, max: 10, default: 1.0 },
      { name: "Jitter", type: "float", min: 0, max: 1, default: 0.5 }
    ],
    inputs: [], outputs: ["Out"]
  },
  {
    type: "Range", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Scale", type: "float", min: 0.1, max: 10, default: 1.0 }
    ],
    inputs: [], outputs: ["Out"]
  },
  {
    type: "Crater", category: "primitives",
    parameters: [
      { name: "Seed", type: "int", default: 0 },
      { name: "Style", type: "enum", default: "New", options: ["New", "Classic"] }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Rugged", category: "primitives",
    parameters: [{ name: "Seed", type: "int", default: 0 }],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "RadialGradient", category: "primitives",
    parameters: [
      { name: "Height", type: "float", min: 0, max: 1, default: 1.0 },
      { name: "Scale", type: "float", min: 0.1, max: 10, default: 1.0 }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  // ── Erosion ─────────────────────────────────────────────────────────────────
  {
    type: "Erosion2", category: "erosion",
    parameters: [
      { name: "Duration",     type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Downcutting",  type: "float", min: 0, max: 1, default: 0.5 },
      { name: "ErosionScale", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed",         type: "int",   default: 0 }
    ],
    inputs: ["In", "Precipitation", "Mask"], outputs: ["Out", "Flow", "Wear", "Deposits"]
  },
  {
    type: "EasyErosion", category: "erosion",
    parameters: [
      { name: "Style",     type: "enum",  default: "Simple", options: ["Simple", "Ancient", "Ancient2", "Alpine", "Rocky", "Exposed", "Flows", "Flows2", "Flows3", "Strata", "Withered", "SoftSoil", "SoftSoil2", "Dessicated", "Thin"] },
      { name: "Influence", type: "float", min: 0, max: 1, default: 0.5 }
    ],
    inputs: ["In"], outputs: ["Out", "Flow", "Wear", "Deposits"]
  },
  {
    type: "ThermalShaper", category: "erosion",
    parameters: [],
    inputs: ["In", "Intensity"], outputs: ["Out"]
  },
  // ── Filters ─────────────────────────────────────────────────────────────────
  {
    type: "FractalTerraces", category: "filter",
    parameters: [
      { name: "Spacing",   type: "float", min: 0, max: 1, default: 0.1 },
      { name: "Intensity", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed",      type: "int",   default: 0 }
    ],
    inputs: ["In", "Modulation"], outputs: ["Out", "Layers"]
  },
  {
    type: "Roughen", category: "filter",
    parameters: [],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Height", category: "filter",
    parameters: [{ name: "Falloff", type: "float", min: 0, max: 1, default: 0.5 }],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Slope", category: "filter",
    parameters: [{ name: "Falloff", type: "float", min: 0, max: 1, default: 0.5 }],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Adjust", category: "filter",
    parameters: [
      { name: "Autolevel", type: "bool", default: false },
      { name: "Strong",    type: "bool", default: false },
      { name: "Shaper",    type: "float", min: 0, max: 1, default: 0.5 }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Autolevel", category: "filter",
    parameters: [],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Deflate", category: "filter",
    parameters: [{ name: "Amount", type: "float", min: 0, max: 1, default: 0.5 }],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Fold", category: "filter",
    parameters: [
      { name: "Waveform", type: "enum", default: "Sine", options: ["Sine", "Triangle", "Sawtooth"] },
      { name: "Folds", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Symmetric", type: "bool", default: false }
    ],
    inputs: ["In", "Folds"], outputs: ["Out"]
  },
  {
    type: "Curvature", category: "filter",
    parameters: [
      { name: "Type", type: "enum", default: "Vertical", options: ["Horizontal", "Vertical", "Average"] }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Clamp", category: "filter",
    parameters: [
      { name: "Min", type: "float", min: 0, max: 1, default: 0 },
      { name: "Max", type: "float", min: 0, max: 1, default: 1 }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Blur", category: "filter",
    parameters: [{ name: "Radius", type: "float", min: 0, max: 1, default: 0.1 }],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "Invert", category: "filter",
    parameters: [],
    inputs: ["In"], outputs: ["Out"]
  },
  // ── Transform ───────────────────────────────────────────────────────────────
  {
    type: "Combine", category: "transform",
    parameters: [
      { name: "Ratio", type: "float",  min: 0, max: 1, default: 0.5 },
      { name: "Mode",  type: "enum",   default: "Add", options: ["Blend", "Add", "Screen", "Subtract", "Difference", "Multiply", "Divide", "Max", "Min", "Overlay", "HardLight", "GrainMerge"] },
      { name: "Enhance", type: "enum", default: "None", options: ["None", "Autolevel", "Equalize"] }
    ],
    inputs: ["In", "Input2", "Mask"], outputs: ["Out"]
  },
  {
    type: "Transform", category: "transform",
    parameters: [
      { name: "OffsetX", type: "float", min: -1, max: 1, default: 0 },
      { name: "OffsetY", type: "float", min: -1, max: 1, default: 0 },
      { name: "Rotation", type: "float", min: 0, max: 360, default: 0 },
      { name: "ScaleX", type: "float", min: 0.1, max: 10, default: 1 },
      { name: "ScaleY", type: "float", min: 0.1, max: 10, default: 1 }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  // ── Snow / weather ──────────────────────────────────────────────────────────
  {
    type: "Snow", category: "weather",
    parameters: [
      { name: "Duration", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Intensity", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "SettleThaw", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "MeltType", type: "enum", default: "Uniform", options: ["Uniform", "Directional"] },
      { name: "Melt", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "SnowLine", type: "float", min: 0, max: 1, default: 0.0 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "SnowMap", "MeltMap"], outputs: ["Out", "Snow", "Hard", "Depth"]
  },
  {
    type: "Snowfield", category: "weather",
    parameters: [
      { name: "Cascades", type: "int", min: 1, max: 10, default: 3 },
      { name: "Duration", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Intensity", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "SettleThaw", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Direction", type: "enum", default: "N", options: ["X", "N", "E", "S", "W"] },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In"], outputs: ["Out", "Snow", "Hard", "Depth"]
  },
  {
    type: "Glacier", category: "weather",
    parameters: [
      { name: "Scale", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Direction", type: "float", min: 0, max: 360, default: 0 },
      { name: "Breakage", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Reference"], outputs: ["Out", "Snow"]
  },
  {
    type: "Weathering", category: "weather",
    parameters: [
      { name: "Scale", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Creep", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Amount", type: "float", min: 0, max: 1, default: 0.5 }
    ],
    inputs: ["In", "Height"], outputs: ["Out"]
  },
  // ── Coloring / data ─────────────────────────────────────────────────────────
  {
    type: "SatMap", category: "data",
    parameters: [
      { name: "Enhance", type: "enum", default: "None", options: ["None", "Autolevel", "Equalize"] },
      { name: "Rough",   type: "enum", default: "Med",  options: ["Low", "Med", "High", "Ultra"] },
      { name: "Bias",    type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Reverse", type: "bool", default: false }
    ],
    inputs: ["In"], outputs: ["Out"]
  },
  {
    type: "SuperColor", category: "data",
    parameters: [
      { name: "Texture", type: "enum", default: "Texture", options: ["None", "Texture", "Peaks", "Flow"] },
      { name: "Strength", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 },
      { name: "Bias", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Reverse", type: "bool", default: false }
    ],
    inputs: ["In", "Texture"], outputs: ["Out"]
  },
  {
    type: "ColorErosion", category: "data",
    parameters: [
      { name: "TransportDistance", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "SedimentDensity", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Height", "Precipitation"], outputs: ["Out"]
  },
  {
    type: "TextureBase", category: "data",
    parameters: [
      { name: "Slope", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Scale", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Soil", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Guide"], outputs: ["Out"]
  },
  {
    type: "GroundTexture", category: "data",
    parameters: [
      { name: "Strength", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Coverage", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Density", type: "float", min: 0, max: 1, default: 0.5 }
    ],
    inputs: ["In", "Mask"], outputs: ["Out"]
  },
  // ── Flow / data extraction ──────────────────────────────────────────────────
  {
    type: "FlowMap", category: "data",
    parameters: [
      { name: "FlowLength", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "FlowVolume", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Precipitation"], outputs: ["Out"]
  },
  // ── Debris ──────────────────────────────────────────────────────────────────
  {
    type: "Debris", category: "filter",
    parameters: [
      { name: "DebrisAmount", type: "int", min: 1, max: 100, default: 10 },
      { name: "Friction", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Restitution", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Emitter"], outputs: ["Out", "ColorIndex", "Debris"]
  },
  {
    type: "Scree", category: "filter",
    parameters: [
      { name: "Scale", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Density", type: "int", min: 1, max: 100, default: 10 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In", "Guide"], outputs: ["Out", "Stones"]
  },
  {
    type: "Crumble", category: "filter",
    parameters: [],
    inputs: ["In", "AreaMask"], outputs: ["Out", "Wear"]
  },
  // ── Sandstone ───────────────────────────────────────────────────────────────
  {
    type: "Sandstone", category: "filter",
    parameters: [
      { name: "Passes", type: "int", min: 1, max: 10, default: 3 },
      { name: "Iterations", type: "int", min: 1, max: 50, default: 12 },
      { name: "Spacing", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Seed", type: "int", default: 0 }
    ],
    inputs: ["In"], outputs: ["Out", "Layers"]
  },
  // ── Output ──────────────────────────────────────────────────────────────────
  {
    type: "Unreal", category: "output",
    parameters: [{ name: "PortCount", type: "int", default: 1 }],
    inputs: ["In"], outputs: ["Out"]
  }
];

// ─── SwarmHostClient ──────────────────────────────────────────────────────────
//
// Supports two construction modes:
//   new SwarmHostClient(7000)             — legacy HTTP mode (keeps old tests green)
//   new SwarmHostClient({ execPath, port, outputDir }) — new CLI mode
//

export class SwarmHostClient {
  /** CLI mode config; null when operating in HTTP mode */
  private readonly cfg: SwarmHostConfig | null;
  /** HTTP base URL; set only in HTTP mode */
  private readonly base: string | null;
  private _currentTerrainPath: string | null = null;

  constructor(configOrPort: SwarmHostConfig | number) {
    if (typeof configOrPort === "number") {
      // Legacy HTTP mode — used by the existing swarmhost.test.ts
      this.cfg  = null;
      this.base = `http://localhost:${configOrPort}`;
    } else {
      // New CLI mode
      this.cfg  = configOrPort;
      this.base = null;

      // Warn (don't crash) if Gaea.BuildManager.exe is missing — graph creation still works
      if (configOrPort.execPath && !existsSync(configOrPort.execPath)) {
        console.error(
          `[gaea-mcp] Warning: Gaea.BuildManager.exe not found at: ${configOrPort.execPath}\n` +
          `  Update "execPath" in swarmhost.config.json to point to your Gaea installation.\n` +
          `  Graph creation will work, but cooking/exporting will fail until this is fixed.`
        );
      }
    }
  }

  get currentTerrainPath(): string | null {
    return this._currentTerrainPath;
  }

  // ── HTTP helpers (legacy mode only) ─────────────────────────────────────────

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    if (!this.base) throw new Error("HTTP request called in CLI mode");
    let res: Response;
    try {
      res = await fetch(`${this.base}${urlPath}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
        throw new Error(
          `Cannot connect to Gaea on ${this.base}. ` +
          "Please ensure Gaea 2.2+ is running and accessible on that port, " +
          "or set port to 0 in swarmhost.config.json to use CLI mode instead."
        );
      }
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SwarmHost ${method} ${urlPath} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    if (this.base) return this.request("GET", "/health");
    return { status: "ok" };
  }

  async listNodeTypes(category?: string): Promise<SwarmNodeType[]> {
    if (this.base) {
      const url = category ? `/nodes?category=${encodeURIComponent(category)}` : "/nodes";
      const data = await this.request<{ nodes: SwarmNodeType[] }>("GET", url);
      return data.nodes;
    }
    // CLI mode: return hardcoded catalog, optionally filtered
    return category
      ? NODE_CATALOG.filter(n => n.category === category)
      : NODE_CATALOG;
  }

  async createGraph(graph: Graph, name?: string): Promise<void> {
    if (this.base) {
      await this.request("POST", "/graph", graph);
      return;
    }
    // CLI mode: serialise graph to a .terrain file
    const cfg = this.cfg!;
    const terrain = buildTerrainFile(graph, cfg.outputDir);
    const safeName = name ? name.replace(/[^a-zA-Z0-9_\-]/g, '_') : 'gaea-mcp';
    const terrainPath = path.join(cfg.outputDir, `${safeName}.terrain`);
    mkdirSync(cfg.outputDir, { recursive: true });
    writeFileSync(terrainPath, serializeGaea(terrain), "utf-8");
    this._currentTerrainPath = terrainPath;
  }

  async loadGraph(terrainPath: string): Promise<void> {
    if (this.base) {
      await this.request("POST", "/graph/load", { path: terrainPath });
      return;
    }
    if (!existsSync(terrainPath)) throw new Error(`Terrain file not found: ${terrainPath}`);
    this._currentTerrainPath = terrainPath;
  }

  async createBlankTerrain(filePath: string): Promise<void> {
    if (this.base) throw new Error("createBlankTerrain not supported in HTTP mode");
    const cfg = this.cfg!;
    const terrain = buildTerrainFile({ nodes: [], edges: [] }, cfg.outputDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, serializeGaea(terrain), "utf-8");
    this._currentTerrainPath = filePath;
  }

  async getGraphState(): Promise<GraphState> {
    if (this.base) return this.request("GET", "/graph/state");
    const terrain = this._readTerrain();
    return parseGraphState(terrain);
  }

  async getParameters(nodeId: string): Promise<SwarmParameter[]> {
    if (this.base) {
      return this.request("GET", `/graph/nodes/${encodeURIComponent(nodeId)}/parameters`);
    }
    const terrain = this._readTerrain();
    const nodeIntId = this._resolveNodeId(nodeId, terrain);
    const node = getAssets(terrain)[0].Terrain.Nodes[nodeIntId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return getNodeParameters(node);
  }

  async setParameter(nodeId: string, parameter: string, value: string | number | boolean): Promise<void> {
    if (this.base) {
      await this.request(
        "PUT",
        `/graph/nodes/${encodeURIComponent(nodeId)}/parameters/${encodeURIComponent(parameter)}`,
        { value }
      );
      return;
    }
    const terrain = this._readTerrain();
    const nodeIntId = this._resolveNodeId(nodeId, terrain);
    const node = getAssets(terrain)[0].Terrain.Nodes[nodeIntId];
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    // Extract node type name from $type for validation
    const nodeTypeName = (node.$type || "").replace("QuadSpinner.Gaea.Nodes.", "").split(",")[0];
    const validatedValue = validateAndFixParameter(nodeTypeName, parameter, value);
    (node as Record<string, unknown>)[parameter] = validatedValue;
    writeFileSync(this._currentTerrainPath!, serializeGaea(terrain), "utf-8");
  }

  async cook(nodeIds?: string[], variables?: Record<string, unknown>, ignorecache = true): Promise<void> {
    if (this.base) {
      await this.request("POST", "/graph/cook", nodeIds ? { nodes: nodeIds } : {});
      return;
    }
    if (!this._currentTerrainPath) {
      throw new Error("No terrain loaded. Call createGraph or loadGraph first.");
    }

    const swarmExe = this.cfg!.swarmExePath ?? detectSwarmPath();
    if (!swarmExe) {
      throw new Error(
        `Gaea.Swarm.exe not found. Install Gaea 2.x or set swarmExePath in swarmhost.config.json.\n` +
        `Checked paths:\n` + GAEA_SWARM_CANDIDATE_PATHS.map(p => `  ${p}`).join("\n")
      );
    }

    // Build args — -v flags MUST come last (Gaea requirement)
    const args: string[] = ["-filename", this._currentTerrainPath];
    if (ignorecache) args.push("-ignorecache");

    if (variables && Object.keys(variables).length > 0) {
      for (const [key, val] of Object.entries(variables)) {
        args.push("-v", `${key}=${val}`);
      }
    }

    const result = cp.spawnSync(swarmExe, args, { encoding: "utf-8", timeout: 300_000 });

    if (result.error) {
      throw new Error(`Failed to start Gaea.Swarm.exe: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const output = result.stderr?.slice(0, 500) || result.stdout?.slice(0, 500) || "";
      throw new Error(`Gaea build failed (exit ${result.status}): ${output}`);
    }
  }

  readTerrainVariables(terrainPath?: string): Record<string, Record<string, unknown>> {
    const p = terrainPath ?? this._currentTerrainPath;
    if (!p) throw new Error("No terrain path provided and no terrain currently loaded.");
    const terrain = JSON.parse(readFileSync(p, "utf-8"));
    const vars = getAssets(terrain)[0]?.Automation?.Variables ?? {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (k === "$id") continue;
      result[k] = v as Record<string, unknown>;
    }
    return result;
  }

  setTerrainVariables(
    contract: Record<string, { type: string; default: unknown; min?: number; max?: number; description: string }>,
    values: Record<string, unknown>,
    terrainPath?: string
  ): void {
    const p = terrainPath ?? this._currentTerrainPath;
    if (!p) throw new Error("No terrain path provided and no terrain currently loaded.");
    const terrain = JSON.parse(readFileSync(p, "utf-8"));
    const automation = getAssets(terrain)[0].Automation;
    const existing = automation.Variables ?? {};
    const existingId = (existing as Record<string, unknown>)["$id"] ?? String(findMaxJsonId(terrain) + 1);

    // Contract is authoritative — any variables not in the contract are removed from the file.
    const newVars: Record<string, unknown> = { "$id": existingId };
    for (const [name, spec] of Object.entries(contract)) {
      const value = name in values ? values[name] : spec.default;
      newVars[name] = {
        Type: spec.type,
        Value: value,
        ...(spec.min !== undefined && { Min: spec.min }),
        ...(spec.max !== undefined && { Max: spec.max }),
        Name: name,
      };
    }
    automation.Variables = newVars;
    writeFileSync(p, serializeGaea(terrain), "utf-8");
  }

  async export(outputDir: string, format: "PNG" | "EXR"): Promise<ExportResult> {
    if (this.base) {
      return this.request("POST", "/graph/export", { outputDir, format });
    }
    // Look for the latest build in the Gaea Builds folder
    const buildsBase = "C:/Users/Admin/Documents/Gaea/Builds";
    const projectName = path.basename(this._currentTerrainPath ?? "", ".terrain");
    const projectBuildsDir = path.join(buildsBase, projectName);

    if (existsSync(projectBuildsDir)) {
      const builds = readdirSync(projectBuildsDir).sort().reverse();
      if (builds.length > 0) {
        const latestBuild = path.join(projectBuildsDir, builds[0]);
        try {
          return findExportFiles(latestBuild);
        } catch {
          // fall through to outputDir fallback
        }
      }
    }

    if (existsSync(outputDir)) {
      return findExportFiles(outputDir);
    }

    throw new Error("No build output found. Run cook() first.");
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _readTerrain(): TerrainFile {
    if (!this._currentTerrainPath) throw new Error("No terrain loaded.");
    return JSON.parse(readFileSync(this._currentTerrainPath, "utf-8")) as TerrainFile;
  }

  private _resolveNodeId(nodeId: string, terrain: TerrainFile): string {
    const nodes = getAssets(terrain)[0].Terrain.Nodes;
    for (const [intId, node] of Object.entries(nodes as Record<string, TerrainNode>)) {
      if (intId === "$id") continue;
      if (node.Name === nodeId || String(node.Id) === nodeId) return intId;
    }
    throw new Error(`Node "${nodeId}" not found in terrain graph`);
  }

  async addNode(
    nodeType: string,
    nodeName: string,
    params: Record<string, unknown> = {},
    position?: { X: number; Y: number }
  ): Promise<void> {
    if (this.base) throw new Error("addNode not supported in HTTP mode");
    const terrain = this._readTerrain();
    const nodes = getAssets(terrain)[0].Terrain.Nodes;

    // Find max numeric $id in the whole file so new $ids don't collide
    const id = makeIdCounter(findMaxJsonId(terrain) + 1);

    const existingIds = Object.values(nodes)
      .filter((n: any) => n && typeof n === "object" && typeof n.Id === "number")
      .map((n: any) => n.Id as number);
    const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 100;

    const pos = position ?? (() => {
      const vals = Object.values(nodes).filter((n: any) => n && typeof n === "object" && n.Position) as any[];
      const maxX = vals.length > 0 ? Math.max(...vals.map((n: any) => n.Position.X)) : 26650;
      const avgY = vals.length > 0
        ? vals.reduce((s: number, n: any) => s + n.Position.Y, 0) / vals.length
        : 26300;
      return { X: maxX + 330, Y: avgY };
    })();

    // Validate all enum params before writing to prevent file corruption
    const validatedParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      validatedParams[k] = validateAndFixParameter(nodeType, k, v);
    }

    const nodeJsonId = id();
    nodes[String(nextId)] = {
      "$id": nodeJsonId,
      "$type": `QuadSpinner.Gaea.Nodes.${nodeType}, Gaea.Nodes`,
      ...validatedParams,
      Id: nextId,
      Name: nodeName,
      Position: { "$id": id(), X: pos.X, Y: pos.Y },
      Ports: {
        "$id": id(), "$values": [
          { "$id": id(), Name: "In", Type: "PrimaryIn", IsExporting: true, Parent: { "$ref": nodeJsonId } },
          { "$id": id(), Name: "Out", Type: "PrimaryOut", IsExporting: true, Parent: { "$ref": nodeJsonId } }
        ]
      },
      Modifiers: { "$id": id(), "$values": [] }
    };

    writeFileSync(this._currentTerrainPath!, serializeGaea(terrain), "utf-8");
  }

  async connectNodes(
    fromId: string, fromPort: string,
    toId: string, toPort: string
  ): Promise<void> {
    if (this.base) throw new Error("connectNodes not supported in HTTP mode");
    const terrain = this._readTerrain();
    const nodes = getAssets(terrain)[0].Terrain.Nodes;
    const id = makeIdCounter(findMaxJsonId(terrain) + 1);

    const fromKey = this._resolveNodeId(fromId, terrain);
    const toKey = this._resolveNodeId(toId, terrain);
    const fromNode = nodes[fromKey];
    const toNode = nodes[toKey];

    const ports = getPorts(toNode);
    let port = ports.find((p: any) => p.Name === toPort);
    if (!port) {
      port = { "$id": id(), Name: toPort, Type: toPort === "In" ? "PrimaryIn, Required" : "In", IsExporting: true, Parent: { "$ref": toNode["$id"] ?? "" } };
      if (Array.isArray(toNode.Ports)) {
        (toNode.Ports as any[]).push(port);
      } else {
        (toNode.Ports as any)["$values"].push(port);
      }
    }
    port.Record = { "$id": id(), From: fromNode.Id, To: toNode.Id, FromPort: fromPort, ToPort: toPort, IsValid: true };

    writeFileSync(this._currentTerrainPath!, serializeGaea(terrain), "utf-8");
  }

  async removeNode(nodeId: string): Promise<void> {
    if (this.base) throw new Error("removeNode not supported in HTTP mode");
    const terrain = this._readTerrain();
    const nodes = getAssets(terrain)[0].Terrain.Nodes;

    const nodeKey = this._resolveNodeId(nodeId, terrain);
    const targetIntId = nodes[nodeKey].Id;

    for (const node of Object.values(nodes) as any[]) {
      for (const port of getPorts(node)) {
        if (port.Record && (port.Record.From === targetIntId || port.Record.To === targetIntId)) {
          delete port.Record;
        }
      }
    }
    delete nodes[nodeKey];

    writeFileSync(this._currentTerrainPath!, serializeGaea(terrain), "utf-8");
  }
}
