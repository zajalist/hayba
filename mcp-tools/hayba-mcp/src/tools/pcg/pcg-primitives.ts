import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python: resolve a node in a PCGGraph by title or index ─────────────
// PCG nodes have no stable string id, so primitives accept either the node's
// visible title (exact or substring) or its 0-based index in graph.get_nodes().
// Verified against UE 5.7: PCGGraph exposes a `nodes` property (NOT
// get_nodes()), PCGNode exposes `node_title` (often empty -> "None" for default
// nodes) and `get_settings()`. So the stable display label is the node_title if
// meaningful, else the settings class name. Pin labels live on
// pin.properties.label (pin.get_name() returns useless "PCGPin_N").
const PY_RESOLVE_NODE = [
  'def _load_graph(p):',
  '    g = unreal.load_asset(p)',
  '    if g is None: raise Exception("graph not found: %s" % p)',
  '    return g',
  'def _node_label(n):',
  '    try:',
  '        t = str(n.node_title)',
  '        if t and t != "None": return t',
  '    except Exception: pass',
  '    try: return type(n.get_settings()).__name__',
  '    except Exception: return "node"',
  'def _resolve_node(g, ref):',
  '    nodes = list(g.nodes)',
  '    if isinstance(ref, int):',
  '        if ref < 0 or ref >= len(nodes): raise Exception("node index out of range: %d" % ref)',
  '        return nodes[ref]',
  '    exact = [n for n in nodes if _node_label(n) == ref]',
  '    if exact: return exact[0]',
  '    sub = [n for n in nodes if ref in _node_label(n)]',
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
    '    # add_node_of_type returns a (node, settings) tuple in UE 5.7.',
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
    '    nodes = list(g.nodes)',
    '    idx = nodes.index(node) if node in nodes else len(nodes)-1',
    '    _emit({"ok": True, "node_index": idx, "node_label": _node_label(node), "settings_class": _cls_name})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const pcgAddNodeDescriptor: PyToolDescriptor<typeof pcgAddNodeSchema.shape> = {
  name: 'pcg_add_node',
  description:
    'Add a node of a given PCG settings class to a graph. Returns node_index + node_label (settings-class-derived) for use with pcg_set_prop / pcg_wire.',
  cost: 'low',
  returns: '{ok, node_index, node_label, settings_class}',
  schema: pcgAddNodeSchema.shape,
  meta: lowMeta,
  buildScript: addNodeScript,
  timeoutMs: 30_000,
};

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
    '    _emit({"ok": True, "node_label": _node_label(node), "path": _path})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const pcgSetPropDescriptor: PyToolDescriptor<typeof pcgSetPropSchema.shape> = {
  name: 'pcg_set_prop',
  description:
    "Set an editor property on a PCG node's settings. Supports nested struct paths like \"distribution_settings/distribution\".",
  cost: 'low',
  returns: '{ok, node_label, path}',
  schema: pcgSetPropSchema.shape,
  meta: lowMeta,
  buildScript: setPropScript,
  timeoutMs: 30_000,
};

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
    '    if not ok: raise Exception("add_edge failed (%s.%s -> %s.%s)" % (_node_label(a), _from_pin, _node_label(b), _to_pin))',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _emit({"ok": True, "from": _node_label(a), "from_pin": _from_pin, "to": _node_label(b), "to_pin": _to_pin})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const pcgWireDescriptor: PyToolDescriptor<typeof pcgWireSchema.shape> = {
  name: 'pcg_wire',
  description:
    "Wire one PCG node's output pin to another node's input pin (by node title or index, and pin label).",
  cost: 'low',
  returns: '{ok, from, from_pin, to, to_pin}',
  schema: pcgWireSchema.shape,
  meta: lowMeta,
  buildScript: wireScript,
  timeoutMs: 30_000,
};

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

export const pcgInspectInstancesDescriptor: PyToolDescriptor<typeof pcgInspectInstancesSchema.shape> = {
  name: 'pcg_inspect_instances',
  description:
    'Read back the Instanced-Static-Mesh instance counts (and a sample transform) produced on an actor by its PCG cook.',
  cost: 'low',
  returns: '{ok, actor, ism:[{mesh,count,sample}], total}',
  schema: pcgInspectInstancesSchema.shape,
  meta: lowMeta,
  buildScript: inspectInstancesScript,
  timeoutMs: 30_000,
};

