import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { runUePythonJson, pyStr } from '../ue-python.js';

// ── Shared Python: resolve a node in a PCGGraph by title or index ─────────────
// PCG nodes have no stable string id, so primitives accept either the node's
// visible title (exact or substring) or its 0-based index in graph.get_nodes().
const PY_RESOLVE_NODE = [
  'def _load_graph(p):',
  '    g = unreal.load_asset(p)',
  '    if g is None: raise Exception("graph not found: %s" % p)',
  '    return g',
  'def _node_title(n):',
  '    try: return str(n.get_node_title())',
  '    except Exception: return ""',
  'def _resolve_node(g, ref):',
  '    nodes = list(g.get_nodes())',
  '    if isinstance(ref, int):',
  '        if ref < 0 or ref >= len(nodes): raise Exception("node index out of range: %d" % ref)',
  '        return nodes[ref]',
  '    exact = [n for n in nodes if _node_title(n) == ref]',
  '    if exact: return exact[0]',
  '    sub = [n for n in nodes if ref in _node_title(n)]',
  '    if len(sub) == 1: return sub[0]',
  '    if len(sub) > 1: raise Exception("ambiguous node ref %r matches %d nodes" % (ref, len(sub)))',
  '    raise Exception("node not found: %r" % ref)',
].join('\n');

const lowMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_asset'],
  when: 'authoring a PCG graph step-by-step instead of hand-rolling python against UE reflection',
  not_when: 'building a whole graph at once — use hayba_create_pcg_graph',
};

// ── pcg_add_node ──────────────────────────────────────────────────────────────
export const pcgAddNodeSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  settings_class: z.string().min(1).describe('PCG settings class name, e.g. "PCGSurfaceSamplerSettings" or "PCGSubdivideSettings"'),
});
export type PcgAddNodeParams = z.infer<typeof pcgAddNodeSchema>;

function addNodeScript(p: PcgAddNodeParams): string {
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_cls_name = ${pyStr(p.settings_class)}`,
    'try:',
    '    g = _load_graph(_graph)',
    '    cls = getattr(unreal, _cls_name, None) or unreal.load_class(None, _cls_name)',
    '    if cls is None: raise Exception("settings class not found: %s" % _cls_name)',
    '    node = None',
    '    for attr in ("add_node_of_type", "add_node"):',
    '        fn = getattr(g, attr, None)',
    '        if fn is None: continue',
    '        try:',
    '            r = fn(cls)',
    '            node = r[0] if isinstance(r, tuple) else r',
    '            break',
    '        except Exception: pass',
    '    if node is None: raise Exception("could not add node of type %s" % _cls_name)',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    nodes = list(g.get_nodes())',
    '    idx = nodes.index(node) if node in nodes else len(nodes)-1',
    '    _emit({"ok": True, "node_index": idx, "node_title": _node_title(node), "settings_class": _cls_name})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgAddNodeHandler(params: PcgAddNodeParams) {
  return run(pcgAddNodeSchema, params, (p) => addNodeScript(p));
}

// ── pcg_set_prop ──────────────────────────────────────────────────────────────
export const pcgSetPropSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  node: z.union([z.string(), z.number().int()]).describe('Node title (exact/substring) or 0-based index in the graph'),
  path: z.string().min(1).describe('Editor-property path on the node\'s settings. Supports nested struct paths with "/", e.g. "distribution_settings/distribution".'),
  value: z.unknown().describe('Value to set (number, bool, string, or array).'),
});
export type PcgSetPropParams = z.infer<typeof pcgSetPropSchema>;

function setPropScript(p: PcgSetPropParams): string {
  const nodeRef = typeof p.node === 'number' ? String(p.node) : pyStr(p.node);
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_node_ref = ${nodeRef}`,
    `_path = ${pyStr(p.path)}`,
    `_value = ${JSON.stringify(p.value)}`,
    'try:',
    '    import json as _j',
    '    g = _load_graph(_graph)',
    '    node = _resolve_node(g, _node_ref)',
    '    settings = node.get_settings()',
    '    parts = [s for s in _path.split("/") if s]',
    '    holder = settings',
    '    for seg in parts[:-1]:',
    '        holder = holder.get_editor_property(seg)',
    '    holder.set_editor_property(parts[-1], _value)',
    '    # struct values are copies — write the (possibly nested) struct back',
    '    if len(parts) > 1:',
    '        settings.set_editor_property(parts[0], settings.get_editor_property(parts[0]))',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _emit({"ok": True, "node_title": _node_title(node), "path": _path})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgSetPropHandler(params: PcgSetPropParams) {
  return run(pcgSetPropSchema, params, (p) => setPropScript(p));
}

// ── pcg_wire ──────────────────────────────────────────────────────────────────
export const pcgWireSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  from_node: z.union([z.string(), z.number().int()]).describe('Source node title or index'),
  from_pin: z.string().optional().default('Out').describe('Source output pin label (default "Out")'),
  to_node: z.union([z.string(), z.number().int()]).describe('Target node title or index'),
  to_pin: z.string().optional().default('In').describe('Target input pin label (default "In"). NOTE: the visible "Map" pin on PCGEx Staging is internally "CollectionSource" — introspect first if unsure.'),
});
export type PcgWireParams = z.infer<typeof pcgWireSchema>;

function wireScript(p: PcgWireParams): string {
  const from = typeof p.from_node === 'number' ? String(p.from_node) : pyStr(p.from_node);
  const to = typeof p.to_node === 'number' ? String(p.to_node) : pyStr(p.to_node);
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_from = ${from}`,
    `_to = ${to}`,
    `_from_pin = ${pyStr(p.from_pin ?? 'Out')}`,
    `_to_pin = ${pyStr(p.to_pin ?? 'In')}`,
    'try:',
    '    g = _load_graph(_graph)',
    '    a = _resolve_node(g, _from)',
    '    b = _resolve_node(g, _to)',
    '    ok = False',
    '    for attr in ("add_edge",):',
    '        fn = getattr(g, attr, None)',
    '        if fn is None: continue',
    '        try: fn(a, _from_pin, b, _to_pin); ok = True; break',
    '        except Exception: pass',
    '    if not ok: raise Exception("add_edge failed (%s.%s -> %s.%s)" % (_node_title(a), _from_pin, _node_title(b), _to_pin))',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _emit({"ok": True, "from": _node_title(a), "from_pin": _from_pin, "to": _node_title(b), "to_pin": _to_pin})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgWireHandler(params: PcgWireParams) {
  return run(pcgWireSchema, params, (p) => wireScript(p));
}

// ── pcg_inspect_instances ────────────────────────────────────────────────────
export const pcgInspectInstancesSchema = z.object({
  actor: z.string().min(1).describe('Label or path of the actor owning the PCGComponent to inspect'),
});
export type PcgInspectInstancesParams = z.infer<typeof pcgInspectInstancesSchema>;

function inspectInstancesScript(p: PcgInspectInstancesParams): string {
  return [
    `_actor_ref = ${pyStr(p.actor)}`,
    'try:',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    target = None',
    '    for a in eas.get_all_level_actors():',
    '        try:',
    '            if a.get_actor_label() == _actor_ref or a.get_path_name() == _actor_ref:',
    '                target = a; break',
    '        except Exception: pass',
    '    if target is None: raise Exception("actor not found: %s" % _actor_ref)',
    '    out = []',
    '    for comp in target.get_components_by_class(unreal.InstancedStaticMeshComponent):',
    '        mesh = comp.static_mesh',
    '        count = comp.get_instance_count()',
    '        sample = None',
    '        if count > 0:',
    '            try:',
    '                t = comp.get_instance_transform(0, True)',
    '                loc = t.translation',
    '                sample = {"location": [loc.x, loc.y, loc.z]}',
    '            except Exception: pass',
    '        out.append({"mesh": (mesh.get_path_name() if mesh else None), "count": count, "sample": sample})',
    '    _emit({"ok": True, "actor": target.get_actor_label(), "ism": out, "total": sum(x["count"] for x in out)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgInspectInstancesHandler(params: PcgInspectInstancesParams) {
  return run(pcgInspectInstancesSchema, params, (p) => inspectInstancesScript(p));
}

export const pcgPrimitiveMeta = lowMeta;

// ── shared run wrapper ────────────────────────────────────────────────────────
async function run<S extends z.ZodTypeAny>(
  schema: S,
  params: unknown,
  build: (p: z.infer<S>) => string,
) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  try {
    const result = await runUePythonJson(build(parsed.data), 30_000);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `pcg primitive error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}
