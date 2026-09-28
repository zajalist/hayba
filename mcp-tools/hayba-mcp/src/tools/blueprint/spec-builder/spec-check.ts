// Every validation rule of the first consumer project's bpgraph.mjs `check`, ported so
// blueprint_spec_check runs with no editor. Pure: no I/O.
//
// Ported from bpgraph.mjs (2026-09-27):
// IDENT, PIN, ENDPOINT, RESERVED_PARAMS, isObj, isScalar, lc, loose,
// classPathProblem, NODE_KINDS, NODE_KIND_NAMES, EVENT_KINDS, POSITION_KEYS,
// nodeKind, parseEndpoint, checkParams, TOP_KEYS, check, checkAcross.
import { parseSpecText, parseType } from './spec-parse.js';
import type { BlueprintSpec, NodeKind } from './spec-types.js';

export type Obj = Record<string, unknown>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PIN = /^[A-Za-z_](?:[A-Za-z0-9_ /]*[A-Za-z0-9_])?$/; // '/' for template pins such as 'Left / Right'
const ENDPOINT = /^([A-Za-z_][A-Za-z0-9_]*)\.(.+)$/;
const RESERVED_PARAMS = new Set(['execute', 'then', 'self']);

export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
export const lc = (s: unknown): string => String(s).toLowerCase();
export const loose = (s: unknown): string => String(s).toLowerCase().replace(/\s+/g, '');

/** A class path the plugin can LoadClass: /Script/Module.Class, or /Game/...Name_C. */
function classPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'must be a class path starting with /';
  if (path.startsWith('/Game/') && !/\.[A-Za-z_]\w*_C$/.test(path)) return 'a Blueprint class path ends in .Name_C, e.g. /Game/Dir/BP_X.BP_X_C';
  if (path.startsWith('/Script/') && !/^\/Script\/\w+\.\w+$/.test(path)) return 'a native class path looks like /Script/Module.Class';
  return null;
}

/** Node kinds: how the kind's value is checked, which extra keys it allows, and
 *  whether the node has input pins (link target) or output pins (link source). */
interface KindRule {
  value: (v: unknown) => true | string;
  extras: string[];
  inputs: boolean;
  outputs: boolean;
  functionOnly?: boolean;
  eventOnly?: boolean;
}

const NODE_KINDS: Record<NodeKind, KindRule> = {
  entry: { value: (v) => v === true || 'must be true', extras: [], inputs: false, outputs: true, functionOnly: true },
  result: { value: (v) => v === true || 'must be true', extras: [], inputs: true, outputs: false, functionOnly: true },
  event: { value: (v) => (typeof v === 'string' && v.trim() !== '') || 'must name an overridable event, e.g. "ReceiveBeginPlay"', extras: [], inputs: false, outputs: true, eventOnly: true },
  custom_event: { value: (v) => (typeof v === 'string' && IDENT.test(v)) || 'must be an identifier', extras: ['inputs'], inputs: false, outputs: true, eventOnly: true },
  bound_event: {
    value: (v) => (isObj(v) && typeof v.target === 'string' && IDENT.test(v.target) && typeof v.event === 'string' && IDENT.test(v.event)
      && Object.keys(v).every((k) => k === 'target' || k === 'event')) || 'must be {"target": <component/widget variable>, "event": <delegate>}',
    extras: [], inputs: false, outputs: true, eventOnly: true,
  },
  call: { value: (v) => (typeof v === 'string' && IDENT.test(v)) || 'must be a function name', extras: ['class'], inputs: true, outputs: true },
  get: { value: (v) => (typeof v === 'string' && IDENT.test(v)) || 'must be a variable name', extras: [], inputs: false, outputs: true },
  set: { value: (v) => (typeof v === 'string' && IDENT.test(v)) || 'must be a variable name', extras: [], inputs: true, outputs: true },
  branch: { value: (v) => v === true || 'must be true', extras: [], inputs: true, outputs: true },
  sequence: { value: (v) => (Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 32) || 'must be the number of outputs, 2..32', extras: [], inputs: true, outputs: true },
  select: { value: (v) => (Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 32) || 'must be the number of options, 2..32', extras: [], inputs: true, outputs: true },
  self: { value: (v) => v === true || 'must be true', extras: [], inputs: false, outputs: true },
  cast: { value: (v) => classPathProblem(v) === null || `class ${classPathProblem(v)}`, extras: [], inputs: true, outputs: true },
  create_widget: { value: (v) => classPathProblem(v) === null || `class ${classPathProblem(v)}`, extras: [], inputs: true, outputs: true },
  timer: { value: (v) => v === true || 'must be true', extras: [], inputs: true, outputs: true },
};
export const NODE_KIND_NAMES: readonly NodeKind[] = Object.keys(NODE_KINDS) as NodeKind[];
export const EVENT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['event', 'custom_event', 'bound_event']);
const POSITION_KEYS = new Set(['x', 'y']);

/** The one kind key of a node spec, or null. */
export function nodeKind(node: unknown): NodeKind | null {
  if (!isObj(node)) return null;
  const kinds = Object.keys(node).filter((k) => k in NODE_KINDS);
  return kinds.length === 1 ? (kinds[0] as NodeKind) : null;
}

export interface Endpoint {
  node: string;
  pin: string;
}

/** Split "node.Pin"; null when the syntax is wrong. */
export function parseEndpoint(endpoint: unknown): Endpoint | null {
  if (typeof endpoint !== 'string') return null;
  const m = ENDPOINT.exec(endpoint);
  if (!m || !PIN.test(m[2])) return null;
  return { node: m[1], pin: m[2] };
}

/** Problems with a {name, type} parameter list (function inputs/outputs, event inputs). */
function checkParams(list: unknown, where: string, errors: string[], namesSoFar: string[] = []): string[] {
  if (list === undefined) return namesSoFar;
  if (!Array.isArray(list)) {
    errors.push(`${where}: must be an array of {"name", "type"}`);
    return namesSoFar;
  }
  if (list.length > 32) errors.push(`${where}: ${list.length} entries; the plugin's limit is 32`);
  const names = [...namesSoFar];
  list.forEach((p: unknown, i: number) => {
    const at = `${where}[${i}]`;
    if (!isObj(p) || typeof p.name !== 'string' || typeof p.type !== 'string') {
      errors.push(`${at}: must be {"name": string, "type": string}`);
      return;
    }
    for (const k of Object.keys(p)) if (k !== 'name' && k !== 'type') errors.push(`${at}: unknown key "${k}"`);
    const name = p.name.trim();
    if (!PIN.test(name)) errors.push(`${at}: name "${p.name}" is not a valid pin name`); // template functions use names like "Left / Right"
    else if (RESERVED_PARAMS.has(lc(name))) errors.push(`${at}: "${name}" is reserved (every node already has a pin by that name)`);
    else if (names.some((n) => lc(n) === lc(name))) errors.push(`${at}: duplicate parameter name "${name}" (names compare case-insensitively)`);
    names.push(name);
    const t = parseType(p.type);
    const tError = 'error' in t ? t.error : undefined;
    if (tError) errors.push(`${at}: ${tError}`);
  });
  return names;
}

const TOP_KEYS = new Set(['asset', 'create', 'variables', 'components', 'functions', 'graphs', 'cdo_defaults', 'description', '$comment']);

/**
 * Validate one spec. `input` is the parsed object or the spec's text.
 * Returns an array of problems; empty means the spec is valid.
 */
export function check(input: unknown): string[] {
  const errors: string[] = [];
  let spec: unknown = input;
  if (typeof input === 'string') {
    try {
      const parsed = parseSpecText(input);
      errors.push(...parsed.duplicates);
      spec = parsed.value;
    } catch (err) {
      return [`not valid JSON: ${(err as Error).message}`];
    }
  }
  if (!isObj(spec)) return [...errors, 'a spec must be a JSON object'];

  for (const k of Object.keys(spec)) if (!TOP_KEYS.has(k)) errors.push(`unknown top-level key "${k}"`);

  if (typeof spec.asset !== 'string' || !/^\/Game(\/[A-Za-z_][A-Za-z0-9_]*)+$/.test(spec.asset)) {
    errors.push('asset: must be a package path like /Game/Dir/BP_Name (no .Name suffix)');
  }

  if (spec.create !== undefined) {
    if (!isObj(spec.create)) errors.push('create: must be {"parent": <class path>}');
    else {
      for (const k of Object.keys(spec.create)) if (k !== 'parent') errors.push(`create: unknown key "${k}"`);
      const problem = classPathProblem(spec.create.parent);
      if (problem) errors.push(`create.parent: ${problem}`);
    }
  }

  // Member names share one namespace on the generated class.
  const members = new Map<string, string>(); // lower name -> "variable X" etc.
  const claim = (name: string, what: string, where: string): void => {
    const prior = members.get(lc(name));
    if (prior) errors.push(`${where}: "${name}" duplicates ${prior}`);
    else members.set(lc(name), `${what} "${name}"`);
  };

  const variables = spec.variables ?? [];
  if (!Array.isArray(variables)) errors.push('variables: must be an array');
  else variables.forEach((v: unknown, i: number) => {
    const at = `variables[${i}]`;
    if (!isObj(v)) { errors.push(`${at}: must be {"name", "type", "default"?}`); return; }
    for (const k of Object.keys(v)) if (!['name', 'type', 'default'].includes(k)) errors.push(`${at}: unknown key "${k}"`);
    if (typeof v.name !== 'string' || !IDENT.test(v.name)) errors.push(`${at}: name must be an identifier`);
    else claim(v.name, 'variable', at);
    const t = parseType(v.type);
    const tError = 'error' in t ? t.error : undefined;
    if (tError) errors.push(`${at} (${String(v.name)}): ${tError}`);
    if ('default' in v && v.default === null) errors.push(`${at} (${String(v.name)}): default must not be null`);
  });

  const components = spec.components ?? [];
  if (!Array.isArray(components)) errors.push('components: must be an array');
  else components.forEach((c: unknown, i: number) => {
    const at = `components[${i}]`;
    if (!isObj(c)) { errors.push(`${at}: must be {"name", "class", "properties"?}`); return; }
    for (const k of Object.keys(c)) if (k !== 'name' && k !== 'class' && k !== 'properties') errors.push(`${at}: unknown key "${k}"`);
    if (typeof c.name !== 'string' || !IDENT.test(c.name)) errors.push(`${at}: name must be an identifier`);
    else claim(c.name, 'component', at);
    const problem = classPathProblem(c.class);
    if (problem) errors.push(`${at} (${String(c.name)}).class: ${problem}`);
    if (c.properties !== undefined) {
      if (!isObj(c.properties) || Object.keys(c.properties).length === 0) {
        errors.push(`${at} (${String(c.name)}).properties: must be a non-empty object of property -> value`);
      } else {
        for (const [k, v] of Object.entries(c.properties)) {
          if (!IDENT.test(k)) errors.push(`${at} (${String(c.name)}).properties["${k}"]: property names are identifiers`);
          if (!isScalar(v)) errors.push(`${at} (${String(c.name)}).properties["${k}"]: value must be a string, number or boolean`);
        }
      }
    }
  });

  const functions = new Map<string, Obj>(); // lower name -> function spec
  const fnList = spec.functions ?? [];
  if (!Array.isArray(fnList)) errors.push('functions: must be an array');
  else fnList.forEach((f: unknown, i: number) => {
    const at = `functions[${i}]`;
    if (!isObj(f)) { errors.push(`${at}: must be {"name", "inputs"?, "outputs"?, "pure"?}`); return; }
    for (const k of Object.keys(f)) if (!['name', 'inputs', 'outputs', 'pure'].includes(k)) errors.push(`${at}: unknown key "${k}"`);
    if (typeof f.name !== 'string' || !IDENT.test(f.name)) { errors.push(`${at}: name must be an identifier`); return; }
    claim(f.name, 'function', at);
    functions.set(lc(f.name), f);
    const names = checkParams(f.inputs, `${at} (${f.name}).inputs`, errors);
    checkParams(f.outputs, `${at} (${f.name}).outputs`, errors, names);
    if (f.pure !== undefined && typeof f.pure !== 'boolean') errors.push(`${at} (${f.name}).pure: must be true or false`);
  });

  const graphs = spec.graphs ?? [];
  const seenGraphs = new Set<string>();
  const customEvents = new Map<string, string>();
  if (!Array.isArray(graphs)) errors.push('graphs: must be an array');
  else graphs.forEach((g: unknown, gi: number) => {
    let at = `graphs[${gi}]`;
    if (!isObj(g)) { errors.push(`${at}: must be {"graph", "nodes", "links"?, "defaults"?}`); return; }
    for (const k of Object.keys(g)) if (!['graph', 'nodes', 'links', 'defaults'].includes(k)) errors.push(`${at}: unknown key "${k}"`);
    if (typeof g.graph !== 'string' || !g.graph) { errors.push(`${at}: graph must be "EventGraph" or a declared function name`); return; }
    at = `graph ${g.graph}`;
    if (seenGraphs.has(lc(g.graph))) errors.push(`${at}: listed twice`);
    seenGraphs.add(lc(g.graph));
    const isEvent = lc(g.graph) === 'eventgraph';
    const fn = functions.get(lc(g.graph));
    if (!isEvent && !fn) errors.push(`${at}: not "EventGraph" and not a function declared in "functions"`);
    const hasOutputs = Array.isArray(fn?.outputs) && (fn?.outputs as unknown[]).length > 0;

    const nodes = g.nodes;
    const kinds = new Map<string, NodeKind>(); // node name -> kind
    if (!isObj(nodes)) errors.push(`${at}: nodes must be an object of name -> node`);
    else for (const [name, node] of Object.entries(nodes)) {
      const nat = `${at} node "${name}"`;
      if (!IDENT.test(name)) errors.push(`${nat}: node names must be identifiers`);
      if (!isObj(node)) {
        errors.push(`${nat}: must be an object with one kind key (${NODE_KIND_NAMES.join(', ')})`);
        continue;
      }
      const present = Object.keys(node).filter((k) => k in NODE_KINDS);
      if (present.length !== 1) {
        const unknown = Object.keys(node).filter((k) => !(k in NODE_KINDS) && !POSITION_KEYS.has(k) && k !== 'class' && k !== 'inputs');
        errors.push(present.length === 0
          ? `${nat}: unknown node kind${unknown.length ? ` "${unknown.join('", "')}"` : ''}; valid kinds: ${NODE_KIND_NAMES.join(', ')}`
          : `${nat}: has ${present.length} kind keys (${present.join(', ')}); a node has exactly one`);
        continue;
      }
      const kind = present[0] as NodeKind;
      kinds.set(name, kind);
      const rule = NODE_KINDS[kind];
      const verdict = rule.value(node[kind]);
      if (verdict !== true) errors.push(`${nat}: "${kind}" ${verdict}`);
      for (const k of Object.keys(node)) {
        if (k === kind || POSITION_KEYS.has(k) || rule.extras.includes(k)) continue;
        errors.push(`${nat}: key "${k}" is not valid on a ${kind} node`);
      }
      for (const k of POSITION_KEYS) if (k in node && !Number.isFinite(node[k])) errors.push(`${nat}: ${k} must be a number`);
      if (kind === 'call' && node.class !== undefined) {
        const problem = classPathProblem(node.class);
        if (problem) errors.push(`${nat}: class ${problem}`);
      }
      if (kind === 'custom_event') {
        checkParams(node.inputs, `${nat}.inputs`, errors);
        const evName = node.custom_event;
        if (typeof evName === 'string') {
          if (customEvents.has(lc(evName))) errors.push(`${nat}: custom event "${evName}" is declared twice (also ${customEvents.get(lc(evName))})`);
          else customEvents.set(lc(evName), nat);
          if (members.has(lc(evName))) errors.push(`${nat}: custom event "${evName}" duplicates ${members.get(lc(evName))}`);
        }
      }
      if (rule.eventOnly && !isEvent) errors.push(`${nat}: ${kind} nodes live in the EventGraph, not a function graph`);
      if (rule.functionOnly && isEvent) errors.push(`${nat}: ${kind} nodes exist only in function graphs, not the EventGraph`);
      if (kind === 'result' && fn && !hasOutputs) errors.push(`${nat}: function ${String(fn.name)} declares no outputs, so it has no result node`);
    }
    const countKind = (k: NodeKind): number => [...kinds.values()].filter((v) => v === k).length;
    if (countKind('entry') > 1) errors.push(`${at}: more than one entry node`);
    if (countKind('result') > 1) errors.push(`${at}: more than one result node`);

    // Links: "node.Pin" output -> "node.Pin" input, both nodes declared.
    const targets = new Map<string, unknown>();
    const execSources = new Map<string, unknown>();
    const linkKeys = new Set<string>();
    const linked = new Set<string>();
    const links = g.links ?? [];
    if (!Array.isArray(links)) errors.push(`${at}: links must be an array of ["from.Pin", "to.Pin"]`);
    else links.forEach((link: unknown, li: number) => {
      const lat = `${at} links[${li}]`;
      if (!Array.isArray(link) || link.length !== 2 || !link.every((e) => typeof e === 'string')) {
        errors.push(`${lat}: must be ["from.Pin", "to.Pin"]`);
        return;
      }
      const [a, b] = link.map(parseEndpoint);
      if (!a) errors.push(`${lat}: "${link[0]}" is not "node.Pin"`);
      if (!b) errors.push(`${lat}: "${link[1]}" is not "node.Pin"`);
      if (!a || !b) return;
      const text = `${link[0]} -> ${link[1]}`;
      for (const [end, role] of [[a, 'from'], [b, 'to']] as const) {
        if (!isObj(nodes) || !(end.node in nodes)) errors.push(`${lat} (${text}): ${role} node "${end.node}" is not declared in nodes`);
      }
      const ka = kinds.get(a.node);
      const kb = kinds.get(b.node);
      if (ka && !NODE_KINDS[ka].outputs) errors.push(`${lat} (${text}): a ${ka} node has no output pins to link from`);
      if (kb && !NODE_KINDS[kb].inputs) errors.push(`${lat} (${text}): a ${kb} node has no input pins to link to`);
      if (lc(a.pin) === 'execute') errors.push(`${lat} (${text}): "execute" is an input pin; links run output -> input`);
      if (/^(then|else|then_\d+|castfailed)$/i.test(b.pin)) errors.push(`${lat} (${text}): "${b.pin}" is an output pin; links run output -> input`);
      if (a.node === b.node) errors.push(`${lat} (${text}): links a node to itself`);
      const key = `${loose(link[0])}>${loose(link[1])}`;
      if (linkKeys.has(key)) errors.push(`${lat} (${text}): duplicate link`);
      linkKeys.add(key);
      // A data input takes one link; an exec output drives one node.
      const tkey = `${b.node}.${loose(b.pin)}`;
      if (lc(b.pin) !== 'execute') {
        if (targets.has(tkey)) errors.push(`${lat} (${text}): input ${link[1]} is already linked from ${targets.get(tkey)}`);
        targets.set(tkey, link[0]);
      }
      if (/^(then|else|then_\d+|castfailed)$/i.test(a.pin)) {
        const skey = `${a.node}.${lc(a.pin)}`;
        if (execSources.has(skey)) errors.push(`${lat} (${text}): exec output ${link[0]} already drives ${execSources.get(skey)}`);
        execSources.set(skey, link[1]);
      }
      linked.add(tkey);
    });

    const defaults = g.defaults ?? {};
    if (!isObj(defaults)) errors.push(`${at}: defaults must be an object of "node.Pin" -> value`);
    else for (const [endpoint, value] of Object.entries(defaults)) {
      const dat = `${at} defaults["${endpoint}"]`;
      const e = parseEndpoint(endpoint);
      if (!e) {
        errors.push(`${dat}: key is not "node.Pin"`);
        continue;
      }
      if (!isObj(nodes) || !(e.node in nodes)) errors.push(`${dat}: node "${e.node}" is not declared in nodes`);
      const k = kinds.get(e.node);
      if (k && !NODE_KINDS[k].inputs) errors.push(`${dat}: a ${k} node has no input pins to set`);
      if (!isScalar(value)) errors.push(`${dat}: value must be a string, number or boolean`);
      if (linked.has(`${e.node}.${loose(e.pin)}`)) errors.push(`${dat}: the pin is also linked; a literal on a linked pin is ignored`);
    }
  });

  if (spec.cdo_defaults !== undefined) {
    if (!isObj(spec.cdo_defaults) || Object.keys(spec.cdo_defaults).length === 0) errors.push('cdo_defaults: must be a non-empty object of property -> value');
    else for (const [k, v] of Object.entries(spec.cdo_defaults)) {
      if (!IDENT.test(k)) errors.push(`cdo_defaults["${k}"]: property names are identifiers`);
      if (v === null) errors.push(`cdo_defaults["${k}"]: value must not be null`);
    }
  }
  return errors;
}

/** Problems that span specs built together (the same asset twice). */
export function checkAcross(entries: ReadonlyArray<{ file: string; spec: unknown }>): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const { file, spec } of entries) {
    if (!isObj(spec) || typeof spec.asset !== 'string') continue;
    const key = lc(spec.asset);
    if (seen.has(key)) errors.push(`${file}: asset ${spec.asset} is also built by ${seen.get(key)}`);
    else seen.set(key, file);
  }
  return errors;
}

/** Inputs the K2 schema refuses a literal on (by-reference parameters), found
 *  live in the first consumer project on UE 5.8. Extend when another one is found. */
export const KNOWN_BY_REF_INPUTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['Conv_TextToString', ['InText']],
  ['K2_ClearAndInvalidateTimerHandle', ['Handle']],
]);

/** Warnings for literals on by-reference inputs of known functions. They are
 *  warnings, not errors: the table is partial, and apply_graph refuses the
 *  literal anyway, naming the pin. */
export function byRefLiteralWarnings(spec: BlueprintSpec, byRef: ReadonlyMap<string, readonly string[]> = KNOWN_BY_REF_INPUTS): string[] {
  const out: string[] = [];
  for (const g of spec.graphs ?? []) {
    for (const endpoint of Object.keys(g.defaults ?? {})) {
      const e = parseEndpoint(endpoint);
      if (!e) continue;
      const node = g.nodes?.[e.node];
      const fn = node && typeof node.call === 'string' ? node.call : undefined;
      const pins = fn ? [...byRef.entries()].find(([name]) => loose(name) === loose(fn))?.[1] : undefined;
      if (pins?.some((p) => loose(p) === loose(e.pin))) {
        out.push(`graph ${g.graph} defaults["${endpoint}"]: ${e.pin} is a by-reference input of ${fn}; the editor refuses a literal there — link a variable get into it instead`);
      }
    }
  }
  return out;
}

/** Node and link totals of a spec, as reported by blueprint_spec_check. */
export function countSpec(spec: BlueprintSpec): { nodes: number; links: number } {
  let nodes = 0;
  let links = 0;
  for (const g of spec.graphs ?? []) {
    nodes += Object.keys(g.nodes ?? {}).length;
    links += (g.links ?? []).length;
  }
  return { nodes, links };
}
