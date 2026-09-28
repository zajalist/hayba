// Pure planning for blueprint_build_from_spec: what to create, what to place,
// what to link — and where, when building copies under target_root.
//
// resolvePin, layoutNodes, findTerminals and signatureProblems are ported from
// the first consumer project's bpgraph.mjs (2026-09-27).
import { isObj, lc, loose, nodeKind, parseEndpoint, type Endpoint } from './spec-check.js';
import type {
  BlueprintSpec, ComponentSpec, FunctionSpec, GraphSpec, NodeKind, NodeSpec, ParamSpec, SpecEntry, VariableSpec,
} from './spec-types.js';

export interface InspectedPin { name: string; direction: 'input' | 'output'; type?: string; default?: string }
export interface InspectedNode { node_id: string; title: string; enabled?: boolean; pins: InspectedPin[] }
export interface InspectedEdge { from_node: string; from_pin: string; to_node: string; to_pin: string }
export interface InspectedGraph { nodes: InspectedNode[]; edges: InspectedEdge[]; node_count: number; edge_count: number }

/** A record keyed by spec node names. It has no prototype, so an inherited
 *  name such as "toString" is never already present and "__proto__" is an
 *  ordinary key. Reads still go through Object.hasOwn. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

// ─── Pins and layout (ported from bpgraph.mjs) ───────────────────────────────

/**
 * Find the real pin a spec names. Exact name first, then case/space-insensitive,
 * then (cast nodes) "As" for the single output whose name starts with "As".
 * `pins` are Hayba pin descriptions {name, direction}. Returns { name } or { error }.
 */
export function resolvePin(
  pins: InspectedPin[] | undefined,
  wanted: string,
  direction: 'input' | 'output',
  { cast = false }: { cast?: boolean } = {},
): { name: string } | { error: string } {
  const candidates = (pins ?? []).filter((p) => p.direction === direction);
  const exact = candidates.find((p) => p.name === wanted);
  if (exact) return { name: exact.name };
  const near = candidates.filter((p) => loose(p.name) === loose(wanted));
  if (near.length === 1) return { name: near[0].name };
  if (near.length > 1) return { error: `"${wanted}" matches several ${direction} pins: ${near.map((p) => p.name).join(', ')}` };
  if (cast && loose(wanted) === 'as') {
    const as = candidates.filter((p) => /^as/i.test(p.name));
    if (as.length === 1) return { name: as[0].name };
  }
  const names = candidates.map((p) => `"${p.name}"`).join(', ') || '(none)';
  return { error: `no ${direction} pin "${wanted}"; its ${direction} pins are ${names}` };
}

/** Layered positions: a node sits one column right of the nodes that feed it;
 *  a node fed by nothing sits just left of its first consumer. */
export function layoutNodes(names: string[], links: ReadonlyArray<readonly [string, string]>): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>(names.map((n) => [n, 0]));
  const edges: Array<[string, string]> = [];
  for (const link of links ?? []) {
    const a = parseEndpoint(link?.[0]);
    const b = parseEndpoint(link?.[1]);
    if (a && b && a.node !== b.node && depth.has(a.node) && depth.has(b.node)) edges.push([a.node, b.node]);
  }
  const limit = names.length;
  for (let pass = 0; pass < limit; pass++) {
    let changed = false;
    for (const [u, v] of edges) {
      if (depth.get(v)! < depth.get(u)! + 1 && depth.get(u)! + 1 <= limit) {
        depth.set(v, depth.get(u)! + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const fed = new Set(edges.map(([, v]) => v));
  for (const n of names) {
    if (fed.has(n)) continue;
    const next = edges.filter(([u]) => u === n).map(([, v]) => depth.get(v)!);
    if (next.length) depth.set(n, Math.max(0, Math.min(...next) - 1));
  }
  const rows = new Map<number, number>();
  const out = dict<{ x: number; y: number }>();
  for (const n of names) {
    const d = depth.get(n)!;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    out[n] = { x: 320 + d * 360, y: row * 220 };
  }
  return out;
}

/** The function entry and result nodes of an inspected function graph. */
export function findTerminals(
  nodes: InspectedNode[],
  functionName: string,
  known: { entry?: string; result?: string } = {},
): { entry?: InspectedNode; result?: InspectedNode; resultCount: number } {
  const byId = (id?: string): InspectedNode | undefined => (id ? nodes.find((n) => n.node_id === id) : undefined);
  const inputs = (n: InspectedNode): InspectedPin[] => n.pins.filter((p) => p.direction === 'input');
  const outputs = (n: InspectedNode): InspectedPin[] => n.pins.filter((p) => p.direction === 'output');
  const entry = byId(known.entry)
    ?? nodes.find((n) => loose(n.title) === loose(functionName) && inputs(n).length === 0 && n.pins.some((p) => p.name === 'then'));
  const results = nodes.filter((n) => n.title === 'Return Node' && outputs(n).length === 0 && n.pins.some((p) => p.name === 'execute'));
  const result = byId(known.result) ?? results[0];
  return { entry, result, resultCount: results.length };
}

/**
 * Where an existing function's signature (read from its entry/result pins)
 * differs from the spec's. Hayba cannot edit a signature, so any difference is
 * an error. Returns messages; empty when they match.
 */
export function signatureProblems(
  terminals: { entry?: { pins: InspectedPin[] }; result?: { pins: InspectedPin[] } },
  fnSpec: FunctionSpec,
): string[] {
  // Function libraries add a hidden __WorldContext parameter; it is not part of the spec.
  const have = (node: { pins: InspectedPin[] } | undefined, dir: string, skip: string): string[] => (node?.pins ?? [])
    .filter((p) => p.direction === dir && p.name !== skip && p.type !== 'delegate' && !p.name.startsWith('__'))
    .map((p) => lc(p.name)).sort();
  const want = (list: ParamSpec[] | undefined): string[] => (list ?? []).map((p) => lc(p.name)).sort();
  const problems: string[] = [];
  const name = fnSpec.name;
  if (!terminals.entry) problems.push(`function ${name} exists but has no recognisable entry node`);
  else if (have(terminals.entry, 'output', 'then').join() !== want(fnSpec.inputs).join()) {
    problems.push(`function ${name} exists with inputs [${have(terminals.entry, 'output', 'then')}], spec says [${want(fnSpec.inputs)}]; Hayba cannot change a signature`);
  }
  if (have(terminals.result, 'input', 'execute').join() !== want(fnSpec.outputs).join()) {
    problems.push(`function ${name} exists with outputs [${have(terminals.result, 'input', 'execute')}], spec says [${want(fnSpec.outputs)}]; Hayba cannot change a signature`);
  }
  return problems;
}

// ─── Plan and apply_graph payload types ──────────────────────────────────────

export type ApplyNodeKind = 'existing' | 'call' | 'get' | 'set' | 'branch' | 'sequence' | 'select' | 'self' | 'cast' | 'create_widget' | 'timer';
export interface ApplyNode { key: string; kind: ApplyNodeKind; node_id?: string; function?: string; class?: string; variable?: string; count?: number; x: number; y: number }
export interface ApplyDefault { node: string; pin: string; value: string }
export interface ApplyLink { from_node: string; from_pin: string; to_node: string; to_pin: string }
export interface ApplyGraphPayload { path: string; graph_name: string; nodes: ApplyNode[]; defaults: ApplyDefault[]; links: ApplyLink[] }

export interface PlannedEvent { key: string; kind: 'event' | 'custom_event' | 'bound_event'; event: string; target?: string; inputs?: ParamSpec[]; x: number; y: number }
export interface PlannedLink { text: string; from: Endpoint; to: Endpoint; fromKind: NodeKind; toKind: NodeKind }
export interface PlannedGraph {
  graph: string;
  isEvent: boolean;
  /** Every node the graph declares, by spec name (a prototype-free record). */
  nodeKinds: Record<string, NodeKind>;
  terminalKeys: { entry?: string; result?: string };
  eventNodes: PlannedEvent[];
  applyNodes: ApplyNode[];
  applyDefaults: ApplyDefault[];
  applyLinks: ApplyLink[];
  specLinks: PlannedLink[];
  /** Event nodes a spec link leaves from; each must read back enabled. */
  linkedEventKeys: string[];
}
export interface PlannedAsset {
  asset: string;
  /** The spec's own asset path before any target_root rewrite. */
  sourceAsset: string;
  name: string;
  create?: { parent: string };
  /** Copy this live asset first (a spec with no "create", built under target_root). */
  duplicateFrom?: string;
  variables: VariableSpec[];
  components: ComponentSpec[];
  functions: FunctionSpec[];
  graphs: PlannedGraph[];
  cdoDefaults?: Record<string, unknown>;
}
export interface BuildPlan {
  assets: PlannedAsset[];
  errors: string[];
  warnings: string[];
  totals: { assets: number; graphs: number; nodes: number; links: number; defaults: number };
}
export interface PlanOptions { targetRoot?: string; allowLivePaths?: boolean }

// ─── Live paths and target_root ──────────────────────────────────────────────

/** Environment variable naming the protected asset roots, comma-separated. */
export const PROTECTED_ASSET_ROOTS_ENV = 'HAYBA_PROTECTED_ASSET_ROOTS';
/** The protected roots when PROTECTED_ASSET_ROOTS_ENV is unset: none. Hayba
 *  names no project's folders; a caller protects its own live folders by setting
 *  PROTECTED_ASSET_ROOTS_ENV. */
export const DEFAULT_PROTECTED_ASSET_ROOTS: readonly string[] = [];

/**
 * Folders a build never writes to unless allow_live_paths is set (spec §5.4).
 * Read from HAYBA_PROTECTED_ASSET_ROOTS on every call: unset means the default,
 * an empty value protects nothing.
 */
export function protectedAssetRoots(): readonly string[] {
  const raw = process.env[PROTECTED_ASSET_ROOTS_ENV];
  if (raw === undefined) return DEFAULT_PROTECTED_ASSET_ROOTS;
  return raw.split(',').map((r) => r.trim().replace(/\/+$/, '')).filter((r) => r !== '');
}

const PACKAGE_FOLDER = /^\/Game(\/[A-Za-z_][A-Za-z0-9_]*)+$/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The longest folder every asset of the batch lives under. */
export function commonAssetRoot(assets: string[]): string {
  if (assets.length === 0) return '';
  const dirs = assets.map((a) => a.slice(0, a.lastIndexOf('/')).split('/'));
  let n = dirs[0].length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && i < d.length && d[i] === dirs[0][i]) i++;
    n = i;
  }
  return dirs[0].slice(0, n).join('/');
}

/**
 * Move a batch under targetRoot, keeping each asset's path below the batch's
 * common folder. Every string that names a batch asset — its package path, or
 * that path followed by ".", ">" or the end — is rewritten, wherever it sits
 * (types, class paths, pin literals, CDO values). Package paths compare
 * case-insensitively, as in the editor; a longer path that merely ends with a
 * batch path is a different asset. Other assets, even under the same folder,
 * stay where they are: the copies read them, never write them. One pass per
 * string, so a rewritten path is never rewritten again.
 */
export function rewriteTargetRoot(entries: SpecEntry[], targetRoot: string): SpecEntry[] {
  if (entries.length === 0) return [];
  const root = commonAssetRoot(entries.map((e) => e.spec.asset));
  const moveTo = new Map(entries.map((e) => [lc(e.spec.asset), targetRoot + e.spec.asset.slice(root.length)]));
  const sources = [...moveTo.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const pattern = new RegExp(`(?<![A-Za-z0-9_/])(?:${sources.join('|')})(?=$|[.>])`, 'gi');
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(pattern, (m) => moveTo.get(lc(m))!);
    if (Array.isArray(v)) return v.map(rewrite);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return entries.map((e) => ({ file: e.file, spec: rewrite(e.spec) as BlueprintSpec }));
}

/** One problem per asset under a protected root (see protectedAssetRoots). */
export function livePathProblems(assets: string[], allowLive: boolean): string[] {
  if (allowLive) return [];
  const roots = protectedAssetRoots();
  const out: string[] = [];
  for (const asset of assets) {
    const root = roots.find((r) => lc(asset) === lc(r) || lc(asset).startsWith(`${lc(r)}/`));
    if (root !== undefined) {
      out.push(`${asset} is under ${root}, a protected folder (${PROTECTED_ASSET_ROOTS_ENV}) that is never rebuilt by default; pass target_root to build a copy, or allow_live_paths: true to rebuild it on purpose`);
    }
  }
  return out;
}

// ─── Build plan ──────────────────────────────────────────────────────────────

function toApplyNode(key: string, kind: NodeKind, node: NodeSpec, x: number, y: number): ApplyNode {
  const cls = typeof node.class === 'string' ? { class: node.class } : {};
  switch (kind) {
    case 'call': return { key, kind, function: String(node.call), ...cls, x, y };
    case 'get': return { key, kind, variable: String(node.get), x, y };
    case 'set': return { key, kind, variable: String(node.set), x, y };
    case 'sequence': return { key, kind, count: Number(node.sequence), x, y };
    case 'select': return { key, kind, count: Number(node.select), x, y };
    case 'cast': return { key, kind, class: String(node.cast), x, y };
    case 'create_widget': return { key, kind, class: String(node.create_widget), x, y };
    case 'branch':
    case 'self':
    case 'timer':
      return { key, kind, x, y };
    default:
      throw new Error(`node "${key}": ${kind} is not placed through apply_graph`);
  }
}

/**
 * Plan one graph. The spec has passed check(), but check() tests "name in
 * nodes", which an inherited name such as "toString" passes; here every node
 * name is an own key of `nodes` or it is refused (into `errors`) and left out.
 */
function planGraph(g: GraphSpec, file: string, errors: string[]): PlannedGraph {
  const at = `${file}: graph ${g.graph}`;
  const nodes = g.nodes;
  const links = g.links ?? [];
  const layout = layoutNodes(Object.keys(nodes), links);
  const plan: PlannedGraph = {
    graph: g.graph, isEvent: lc(g.graph) === 'eventgraph', nodeKinds: dict<NodeKind>(), terminalKeys: {},
    eventNodes: [], applyNodes: [], applyDefaults: [], applyLinks: [], specLinks: [], linkedEventKeys: [],
  };
  const planned = (name: string): boolean => Object.hasOwn(plan.nodeKinds, name);
  for (const [key, node] of Object.entries(nodes)) {
    const kind = nodeKind(node);
    if (!kind) {
      errors.push(`${at} node "${key}": needs exactly one node kind; run blueprint_spec_check`);
      continue;
    }
    plan.nodeKinds[key] = kind;
    const x = Math.round(typeof node.x === 'number' ? node.x : layout[key].x);
    const y = Math.round(typeof node.y === 'number' ? node.y : layout[key].y);
    if (kind === 'entry' || kind === 'result') plan.terminalKeys[kind] = key;
    else if (kind === 'event') plan.eventNodes.push({ key, kind, event: String(node.event), x, y });
    else if (kind === 'custom_event') plan.eventNodes.push({ key, kind, event: String(node.custom_event), inputs: (node.inputs as ParamSpec[] | undefined) ?? [], x, y });
    else if (kind === 'bound_event') {
      const b = node.bound_event as { target: string; event: string };
      plan.eventNodes.push({ key, kind, event: b.event, target: b.target, x, y });
    } else plan.applyNodes.push(toApplyNode(key, kind, node, x, y));
  }
  links.forEach(([a, b], li) => {
    const lat = `${at} links[${li}] (${a} -> ${b})`;
    const from = parseEndpoint(a);
    const to = parseEndpoint(b);
    if (!from || !to) {
      errors.push(`${lat}: each end must be "node.Pin"`);
      return;
    }
    for (const [end, role] of [[from, 'from'], [to, 'to']] as const) {
      if (!Object.hasOwn(nodes, end.node)) errors.push(`${lat}: ${role} node "${end.node}" is not declared in nodes`);
    }
    if (!planned(from.node) || !planned(to.node)) return;
    plan.applyLinks.push({ from_node: from.node, from_pin: from.pin, to_node: to.node, to_pin: to.pin });
    plan.specLinks.push({ text: `${a} -> ${b}`, from, to, fromKind: plan.nodeKinds[from.node], toKind: plan.nodeKinds[to.node] });
  });
  for (const [endpoint, value] of Object.entries(g.defaults ?? {})) {
    const dat = `${at} defaults["${endpoint}"]`;
    const e = parseEndpoint(endpoint);
    if (!e) {
      errors.push(`${dat}: key is not "node.Pin"`);
      continue;
    }
    if (!Object.hasOwn(nodes, e.node)) errors.push(`${dat}: node "${e.node}" is not declared in nodes`);
    if (!planned(e.node)) continue;
    plan.applyDefaults.push({ node: e.node, pin: e.pin, value: String(value) });
  }
  plan.linkedEventKeys = plan.eventNodes.map((e) => e.key).filter((k) => plan.specLinks.some((l) => l.from.node === k));
  return plan;
}

function planAsset(entry: SpecEntry, sourceAsset: string, copying: boolean, errors: string[]): PlannedAsset {
  const spec = entry.spec;
  return {
    asset: spec.asset,
    sourceAsset,
    name: spec.asset.slice(spec.asset.lastIndexOf('/') + 1),
    ...(spec.create ? { create: spec.create } : {}),
    ...(!spec.create && copying && sourceAsset !== spec.asset ? { duplicateFrom: sourceAsset } : {}),
    variables: spec.variables ?? [],
    components: spec.components ?? [],
    functions: spec.functions ?? [],
    graphs: (spec.graphs ?? []).map((g) => planGraph(g, entry.file, errors)),
    ...(spec.cdo_defaults ? { cdoDefaults: spec.cdo_defaults } : {}),
  };
}

/** Plan a build of checked specs. Specs must already pass check()/checkAcross(). */
export function planBuild(entries: SpecEntry[], opts: PlanOptions = {}): BuildPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  let working = entries;
  let copying = false;
  if (opts.targetRoot !== undefined) {
    if (!PACKAGE_FOLDER.test(opts.targetRoot)) errors.push(`target_root "${opts.targetRoot}" must be a /Game folder path like /Game/Scratch/SpecBuild`);
    else { working = rewriteTargetRoot(entries, opts.targetRoot); copying = true; }
  }
  errors.push(...livePathProblems(working.map((e) => e.spec.asset), opts.allowLivePaths === true));
  const assets = working.map((e, i) => planAsset(e, entries[i].spec.asset, copying, errors));
  for (const a of assets) {
    if (a.duplicateFrom) warnings.push(`${a.asset}: the spec has no "create", so it is copied from ${a.duplicateFrom} and its graphs are rebuilt from the spec`);
  }
  const graphs = assets.flatMap((a) => a.graphs);
  return {
    assets, errors, warnings,
    totals: {
      assets: assets.length,
      graphs: graphs.length,
      nodes: graphs.reduce((n, g) => n + Object.keys(g.nodeKinds).length, 0),
      links: graphs.reduce((n, g) => n + g.specLinks.length, 0),
      defaults: graphs.reduce((n, g) => n + g.applyDefaults.length, 0),
    },
  };
}

/** One graph's apply_graph payload. Nodes placed earlier (events, a function's
 *  entry/result) are referenced by id as `existing`; `ids` maps spec keys to ids. */
export function applyGraphPayload(asset: string, g: PlannedGraph, ids: Readonly<Record<string, string>>): ApplyGraphPayload {
  const placed = new Set(g.applyNodes.map((n) => n.key));
  const referenced = new Set<string>([...g.applyLinks.flatMap((l) => [l.from_node, l.to_node]), ...g.applyDefaults.map((d) => d.node)]);
  const existing: ApplyNode[] = [];
  for (const key of referenced) {
    if (placed.has(key)) continue;
    const id = Object.hasOwn(ids, key) ? ids[key] : undefined;
    if (!id) throw new Error(`graph ${g.graph}: node "${key}" has no node id (it was not placed)`);
    existing.push({ key, kind: 'existing', node_id: id, x: 0, y: 0 });
  }
  return { path: asset, graph_name: g.graph, nodes: [...existing, ...g.applyNodes], defaults: g.applyDefaults, links: g.applyLinks };
}
