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
// No try/with in these templates: native python_run policy HCR-TIME-001 refuses
// them, so _find_graph/_resolve_node return (value, None) | (None, error) for an
// explicit _err, and each tool body is a _go() that returns early on a miss.
// get/set_editor_property raise on a name the type does not export (hasattr only
// sees BlueprintVisible ones), so _has_eprop reads the type docstring, which lists
// every exported property, inherited too, as "- ``name`` (Type): ...".
const PY_RESOLVE_NODE = [
  'def _has_eprop(o, n):',
  '    return ("- ``%s`` " % n) in (type(o).__doc__ or "")',
  'def _eprop_ok(o, n):',
  '    # docstrings list python (snake_case) names, but the editor-property accessors also take the native',
  '    # name hayba_export_pcg_graph prints (e.g. "bUseSeed"), so only a lowercase name is provably missing',
  '    return _has_eprop(o, n) or n != n.lower()',
  'def _find_graph(p):',
  '    g = unreal.load_asset(p)',
  '    if g is None: return None, "graph not found: %s" % p',
  '    if not hasattr(unreal, "PCGGraph") or not isinstance(g, unreal.PCGGraph): return None, "not a PCGGraph: %s (%s)" % (p, type(g).__name__)',
  '    return g, None',
  'def _node_label(n):',
  '    t = str(n.node_title) if hasattr(n, "node_title") else ""',
  '    if t and t != "None": return t',
  '    return type(n.get_settings()).__name__ if hasattr(n, "get_settings") else "node"',
  'def _resolve_node(g, ref):',
  '    nodes = list(g.nodes)',
  '    if isinstance(ref, int):',
  '        if ref < 0 or ref >= len(nodes): return None, "node index out of range: %d" % ref',
  '        return nodes[ref], None',
  '    exact = [n for n in nodes if _node_label(n) == ref]',
  '    if exact: return exact[0], None',
  '    sub = [n for n in nodes if ref in _node_label(n)]',
  '    if len(sub) == 1: return sub[0], None',
  '    if len(sub) > 1: return None, "ambiguous node ref %r matches %d nodes" % (ref, len(sub))',
  '    return None, "node not found: %r" % ref',
  // The graph Input/Output nodes are NOT in g.nodes, so _resolve_node can never',
  // find them. _resolve_node_ext maps the special refs "Input"/"Output" to the',
  // graph I/O nodes (needed to wire a subgraph interface pin), else falls back.',
  'def _graph_io_node(g, which):',
  '    if which == "input":',
  '        n = g.get_input_node() if hasattr(g, "get_input_node") else None',
  '        if n is None and hasattr(g, "input_node"): n = g.input_node',
  '    else:',
  '        n = g.get_output_node() if hasattr(g, "get_output_node") else None',
  '        if n is None and hasattr(g, "output_node"): n = g.output_node',
  '    return n',
  'def _resolve_node_ext(g, ref):',
  '    if isinstance(ref, str):',
  '        low = ref.strip().lower()',
  '        if low in ("input", "input node", "inputnode", "graph input"):',
  '            n = _graph_io_node(g, "input")',
  '            if n is not None: return n, None',
  '        if low in ("output", "output node", "outputnode", "graph output"):',
  '            n = _graph_io_node(g, "output")',
  '            if n is not None: return n, None',
  '    return _resolve_node(g, ref)',
].join('\n');

// ── Shared Python: coerce a JSON value to the target editor-property's type ────
// UE's set_editor_property cannot nativize a bare str/int into an EnumProperty
// or a StructProperty. This mirrors the inverse of the export serializer:
//   - enum: accept the member name ("AllWorldActors" | "ALL_WORLD_ACTORS"),
//     a fully-qualified "EEnum::Member", or an int -> the unreal enum member.
//   - struct: accept a JSON object (recursively coerced field-by-field) or a
//     positional array (e.g. [x,y,z] -> unreal.Vector).
// EnumBase/StructBase are picked with hasattr so a missing symbol degrades to
// "never matches" rather than raising. _coerce returns (value, None) | (None, error).
// UE enum types iterate their entries (.name/.value); etype(val) always raises
// "Cannot create instances of enum types", so entries are matched directly.
const PY_COERCE = [
  'import re as _re',
  '_EB = unreal.EnumBase if hasattr(unreal, "EnumBase") else ()',
  '_SB = unreal.StructBase if hasattr(unreal, "StructBase") else ()',
  'def _safe_get(o, k):',
  '    return o.get_editor_property(k) if _eprop_ok(o, k) else None',
  'def _to_enum(etype, val):',
  '    ents = list(etype)',
  '    iv = int(val) if isinstance(val, int) else None',
  '    if isinstance(val, str):',
  '        v = val.strip()',
  '        if "::" in v: v = v.split("::")[-1]',
  '        cands = [v, v.upper(), _re.sub(r"(?<!^)(?=[A-Z])", "_", v).upper(), v.replace(" ", "_").upper()]',
  '        for c in cands:',
  '            for e in ents:',
  '                if e.name == c: return e, None',
  '        if v.lstrip("-").isdigit(): iv = int(v)',
  '    if iv is not None:',
  '        for e in ents:',
  '            if e.value == iv: return e, None',
  '    return None, "cannot coerce %r to enum %s" % (val, etype.__name__)',
  'def _coerce(cur, val):',
  '    if isinstance(cur, _EB): return _to_enum(type(cur), val)',
  '    if isinstance(cur, _SB):',
  '        # String -> struct via ExportText/ImportText. PCG attribute selectors',
  '        # (FPCGAttributePropertySelector) need the "PCGBegin(<name>)PCGEnd"',
  '        # wrapper; a bare "WallDist" is an attribute, "$Density" a property.',
  '        if isinstance(val, str) and hasattr(cur, "import_text"):',
  '            _v = val.strip()',
  '            if "Selector" in type(cur).__name__ and not _v.startswith("PCGBegin("):',
  '                _v = "PCGBegin(" + _v + ")PCGEnd"',
  '            # import_text raises on a parse error (UE turns ImportText errors into RuntimeError)',
  '            if cur.import_text(_v): return cur, None',
  '        if isinstance(val, dict):',
  '            for k, vv in val.items():',
  '                nv, m = _coerce(_safe_get(cur, k), vv)',
  '                if m is not None: return None, m',
  '                cur.set_editor_property(k, nv)',
  '            return cur, None',
  '        # a positional [x, y, z] stays a list: set_editor_property casts a sequence',
  '        # through the same struct init params as type(cur)(*val)',
  '    return val, None',
].join('\n');

// ── Shared Python: enumerate a node's pin labels ──────────────────────────────
// UPCGNode exposes InputPins / OutputPins as UPROPERTY(BlueprintReadOnly)
// (PCGNode.h:254,257), so they are reachable from Python as the editor
// properties "input_pins" / "output_pins". Each element is a UPCGPin whose
// FPCGPinProperties (UPCGPin::Properties, PCGPin.h:277, BlueprintReadOnly)
// carries the visible Label (FPCGPinProperties::Label, PCGPin.h:68) and
// AllowedTypes (PCGPin.h:74). get_node_title()/get_default_node_title() are NOT
// UFUNCTIONs in UE 5.8 (PCGNode.h:71, PCGSettings.h:376) so the friendly display
// title is NOT reachable from Python — the C++ hayba_export_pcg_graph is the only
// place that can report it (it uses UPCGNode::GetNodeTitle). See §3d note.
const PY_PIN_HELPERS = [
  'def _pin_props(p):',
  '    return p.get_editor_property("properties") if _has_eprop(p, "properties") else None',
  'def _pin_type(p):',
  '    pr = _pin_props(p)',
  '    return str(pr.get_editor_property("allowed_types")) if pr is not None and _has_eprop(pr, "allowed_types") else "Any"',
  'def _pin_label(p):',
  '    # The visible label lives on Properties.Label; pin.get_name() is the',
  '    # useless "PCGPin_N", so it is only the last resort.',
  '    pr = _pin_props(p)',
  '    if pr is not None and _has_eprop(pr, "label"): return str(pr.get_editor_property("label"))',
  '    return str(p.get_name()) if hasattr(p, "get_name") else ""',
  'def _pins(n, is_output):',
  '    k = "output_pins" if is_output else "input_pins"',
  '    return list(n.get_editor_property(k)) if _has_eprop(n, k) else []',
  'def _pin_labels(n, is_output):',
  '    return [_pin_label(p) for p in _pins(n, is_output)]',
].join('\n');

const lowMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_asset'],
  when: 'authoring a PCG graph step-by-step instead of hand-rolling python against UE reflection',
  not_when: 'building a whole graph at once — use hayba_create_pcg_graph',
};

// Read-only tools declare readOnly, so python_run asks for a Read lease instead of a global write that blocks lanes.
const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading a PCG node, its pins, or the instances a cook produced',
  not_when: 'mutating the graph (use pcg_set_prop / pcg_wire)',
};

// ── pcg_add_node ──────────────────────────────────────────────────────────────
export const pcgAddNodeSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  settings_class: z.string().min(1).describe('PCG settings class name, e.g. "PCGSurfaceSamplerSettings" or "PCGSubdivideSettings"'),
});
export type PcgAddNodeParams = z.infer<typeof pcgAddNodeSchema>;

// §3d: UPCGNode::GetNodeTitle / UPCGSettings::GetDefaultNodeTitle are NOT
// UFUNCTIONs in UE 5.8, so Python can't read a node's friendly display title
// (e.g. "Shape : 3D Grid") directly — a freshly-added node reports only its raw
// settings-class name. UHaybaPCGLibrary::GetPCGNodeTitle wraps GetNodeTitle so we
// can surface that title as the node_label. Guarded: if the C++ library isn't
// available (older build) or the title is empty, fall back to _node_label (class
// name) so addressing stays stable and the tool never errors on the label alone.
const PY_FRIENDLY_LABEL = [
  'def _friendly_label(n):',
  '    if hasattr(unreal, "HaybaPCGLibrary") and hasattr(unreal.HaybaPCGLibrary, "get_pcg_node_title"):',
  '        # FullTitle can be multi-line ("Shape\\n3D Grid"); flatten for a',
  '        # single-line, addressable label.',
  '        t = " ".join(str(unreal.HaybaPCGLibrary.get_pcg_node_title(n)).split())',
  '        if t and t != "None": return t',
  '    return _node_label(n)',
].join('\n');

// The settings class is named at runtime, so it is matched against the loaded
// PCGSettings subclasses (unreal.ClassIterator) instead of an unreal.<name>
// lookup; load_class still takes a full "/Script/PCG.X" or "Module.X" path.
// UPCGGraph::AddNode is not a UFUNCTION, so add_node_of_type is the only API.
function addNodeScript(p: PcgAddNodeParams): string {
  return [
    PY_RESOLVE_NODE,
    PY_FRIENDLY_LABEL,
    `_graph = ${pyStr(p.graph)}`,
    `_cls_name = ${pyStr(p.settings_class)}`,
    'def _settings_class(name):',
    '    if not hasattr(unreal, "PCGSettings"): return None',
    '    for c in unreal.ClassIterator(unreal.PCGSettings):',
    '        if c.get_name() == name: return c',
    '    return unreal.load_class(None, name, unreal.PCGSettings)',
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    cls = _settings_class(_cls_name)',
    '    if cls is None: return _err("settings class not found: %s" % _cls_name)',
    '    if not hasattr(g, "add_node_of_type"): return _err("could not add node of type %s" % _cls_name)',
    '    # add_node_of_type returns a (node, settings) tuple in UE 5.7.',
    '    r = g.add_node_of_type(cls)',
    '    node = r[0] if isinstance(r, tuple) else r',
    '    if node is None: return _err("could not add node of type %s" % _cls_name)',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    nodes = list(g.nodes)',
    '    idx = nodes.index(node) if node in nodes else len(nodes)-1',
    '    _emit({"ok": True, "node_index": idx, "node_label": _friendly_label(node), "settings_class": _cls_name})',
    '_go()',
  ].join('\n');
}

export const pcgAddNodeDescriptor: PyToolDescriptor<typeof pcgAddNodeSchema.shape> = {
  name: 'pcg_add_node',
  description:
    'Add a node of a given PCG settings class to a graph. Returns node_index, settings_class, and node_label — node_label is now the friendly display title (e.g. "Shape : 3D Grid") when the HaybaPCGLibrary C++ helper is available, else it falls back to the settings-class name. For STABLE addressing pass either node_index or settings_class to pcg_wire/pcg_set_prop/pcg_remove_node (class-name and index addressing always work; friendly-title addressing depends on the node having an authored title). New nodes land at (0,0) — run pcg_layout afterward to arrange the graph. To remove a node use pcg_remove_node; to inspect its pins before wiring use pcg_list_pins.',
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
  value: z.unknown().describe('Value to set. Scalars (number/bool/string/array) set directly. Enum properties accept the member name ("AllWorldActors" or "ALL_WORLD_ACTORS"), a qualified "EEnum::Member", or an int. Struct properties accept a JSON object (coerced field-by-field, recursively) or a positional array (e.g. [x,y,z] for a Vector). PCG attribute selectors (e.g. a filter\'s target_attribute) accept a bare attribute name "WallDist", a property "$Density", or a full "PCGBegin(...)PCGEnd" string.'),
});
export type PcgSetPropParams = z.infer<typeof pcgSetPropSchema>;

function setPropScript(p: PcgSetPropParams): string {
  const nodeRef = typeof p.node === 'number' ? String(p.node) : pyStr(p.node);
  return [
    PY_RESOLVE_NODE,
    PY_COERCE,
    `_graph = ${pyStr(p.graph)}`,
    `_node_ref = ${nodeRef}`,
    `_path = ${pyStr(p.path)}`,
    // Embed as a JSON string and json.loads it so bools/null/objects arrive as
    // proper Python types (True/False/None/dict/list), not JS literals.
    `_value_json = ${pyStr(JSON.stringify(p.value ?? null))}`,
    'def _go():',
    '    import json as _j',
    '    _value = _j.loads(_value_json)',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    node, m = _resolve_node(g, _node_ref)',
    '    if node is None: return _err(m)',
    '    settings = node.get_settings()',
    '    parts = [s for s in _path.split("/") if s]',
    '    if not parts: return _err("empty property path")',
    '    # Walk down, retaining each struct copy so we can write the chain back.',
    '    chain = [settings]',
    '    for seg in parts[:-1]:',
    '        if not _eprop_ok(chain[-1], seg): return _err("no editor property %r on %s" % (seg, type(chain[-1]).__name__))',
    '        chain.append(chain[-1].get_editor_property(seg))',
    '    holder = chain[-1]',
    '    if not _eprop_ok(holder, parts[-1]): return _err("no editor property %r on %s" % (parts[-1], type(holder).__name__))',
    '    v, m = _coerce(_safe_get(holder, parts[-1]), _value)',
    '    if m is not None: return _err(m)',
    '    holder.set_editor_property(parts[-1], v)',
    '    # Struct get_editor_property returns copies — write each modified level',
    '    # back into its parent, all the way up to the settings object.',
    '    for i in range(len(parts) - 2, -1, -1):',
    '        chain[i].set_editor_property(parts[i], chain[i + 1])',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _emit({"ok": True, "node_label": _node_label(node), "path": _path})',
    '_go()',
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
  from_node: z.union([z.string(), z.number().int()]).describe('Source node title or index. Use "Input" to wire from the graph\'s input node (its output pin is usually labelled "In").'),
  from_pin: z.string().optional().default('Out').describe('Source output pin label (default "Out")'),
  to_node: z.union([z.string(), z.number().int()]).describe('Target node title or index. Use "Output" to wire into the graph\'s output node.'),
  to_pin: z.string().optional().default('In').describe('Target input pin label (default "In"). NOTE: the visible "Map" pin on PCGEx Staging is internally "CollectionSource" — introspect first if unsure.'),
});
export type PcgWireParams = z.infer<typeof pcgWireSchema>;

function wireScript(p: PcgWireParams): string {
  const from = typeof p.from_node === 'number' ? String(p.from_node) : pyStr(p.from_node);
  const to = typeof p.to_node === 'number' ? String(p.to_node) : pyStr(p.to_node);
  return [
    PY_RESOLVE_NODE,
    PY_PIN_HELPERS,
    `_graph = ${pyStr(p.graph)}`,
    `_from = ${from}`,
    `_to = ${to}`,
    `_from_pin = ${pyStr(p.from_pin ?? 'Out')}`,
    `_to_pin = ${pyStr(p.to_pin ?? 'In')}`,
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    a, m = _resolve_node_ext(g, _from)',
    '    if a is None: return _err(m)',
    '    b, m = _resolve_node_ext(g, _to)',
    '    if b is None: return _err(m)',
    // §4: validate pins BEFORE add_edge. A bad pin name otherwise makes add_edge
    // silently drop the wire, which only surfaces as 0 instances at cook time.
    '    _out_labels = _pin_labels(a, True)',
    '    _in_labels = _pin_labels(b, False)',
    '    _bad_from = _from_pin not in _out_labels',
    '    _bad_to = _to_pin not in _in_labels',
    '    if _bad_from or _bad_to:',
    '        _which = ("source pin %r on %s" % (_from_pin, _node_label(a))) if _bad_from else ("target pin %r on %s" % (_to_pin, _node_label(b)))',
    '        _emit({"ok": False, "error": "no such %s — wire NOT created" % _which, "valid_from_pins": _out_labels, "valid_to_pins": _in_labels})',
    '    else:',
    '        if not hasattr(g, "add_edge"): return _err("add_edge failed (%s.%s -> %s.%s)" % (_node_label(a), _from_pin, _node_label(b), _to_pin))',
    '        g.add_edge(a, _from_pin, b, _to_pin)',
    '        unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '        _emit({"ok": True, "from": _node_label(a), "from_pin": _from_pin, "to": _node_label(b), "to_pin": _to_pin})',
    '_go()',
  ].join('\n');
}

export const pcgWireDescriptor: PyToolDescriptor<typeof pcgWireSchema.shape> = {
  name: 'pcg_wire',
  description:
    "Wire one PCG node's output pin to another node's input pin (by node title or index, and pin label). Pin names are VALIDATED first: if from_pin/to_pin does not exist on the node, no wire is created and the result is {ok:false, error, valid_from_pins, valid_to_pins} — it never silently drops the edge. Use pcg_list_pins to discover exact labels. To cut an existing edge use pcg_disconnect.",
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
    'def _go():',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    target = None',
    '    for a in eas.get_all_level_actors():',
    '        if a.get_actor_label() == _actor_ref or a.get_path_name() == _actor_ref:',
    '            target = a; break',
    '    if target is None: return _err("actor not found: %s" % _actor_ref)',
    '    out = []',
    '    for comp in target.get_components_by_class(unreal.InstancedStaticMeshComponent):',
    '        mesh = comp.static_mesh',
    '        count = comp.get_instance_count()',
    '        sample = None',
    '        if count > 0:',
    '            # the bool-returning getter yields a Transform, or None on failure',
    '            t = comp.get_instance_transform(0, True)',
    '            if t is not None and hasattr(t, "translation"):',
    '                loc = t.translation',
    '                sample = {"location": [loc.x, loc.y, loc.z]}',
    '        out.append({"mesh": (mesh.get_path_name() if mesh else None), "count": count, "sample": sample})',
    '    _emit({"ok": True, "actor": target.get_actor_label(), "ism": out, "total": sum(x["count"] for x in out)})',
    '_go()',
  ].join('\n');
}

export const pcgInspectInstancesDescriptor: PyToolDescriptor<typeof pcgInspectInstancesSchema.shape> = {
  name: 'pcg_inspect_instances',
  description:
    'Read back the Instanced-Static-Mesh instance counts (and a sample transform) produced on an actor by its PCG cook.',
  cost: 'low',
  returns: '{ok, actor, ism:[{mesh,count,sample}], total}',
  schema: pcgInspectInstancesSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: inspectInstancesScript,
  timeoutMs: 30_000,
};

// ── pcg_remove_node (§2a) ─────────────────────────────────────────────────────
// Wraps UPCGGraph::RemoveNode(UPCGNode*) (PCGGraph.h:469, BlueprintCallable) →
// Python g.remove_node(node). RemoveNode also tears down the node's incident
// edges (verified: the C++ impl calls RemoveInboundEdges/RemoveOutboundEdges).
// Non-idempotent — a second call with the same ref fails (node already gone).
const removeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_asset'],
  when: 'deleting a PCG node (and its wires) — the destructive half of graph editing',
  not_when: 'cutting a single edge (use pcg_disconnect) or re-config (use pcg_set_prop)',
};

export const pcgRemoveNodeSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  node: z.union([z.string(), z.number().int()]).describe('Node to remove: settings-class title (exact or unambiguous substring) or 0-based index in graph.nodes. Ambiguous substrings error with the match count.'),
});
export type PcgRemoveNodeParams = z.infer<typeof pcgRemoveNodeSchema>;

function removeNodeScript(p: PcgRemoveNodeParams): string {
  const nodeRef = typeof p.node === 'number' ? String(p.node) : pyStr(p.node);
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_node_ref = ${nodeRef}`,
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    node, m = _resolve_node(g, _node_ref)',
    '    if node is None: return _err(m)',
    '    _removed = _node_label(node)',
    '    if not hasattr(g, "remove_node"): return _err("remove_node failed for %r" % _node_ref)',
    '    g.remove_node(node)',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _survivors = [{"index": i, "label": _node_label(n)} for i, n in enumerate(g.nodes)]',
    '    _emit({"ok": True, "removed": _removed, "nodes": _survivors, "node_count": len(_survivors)})',
    '_go()',
  ].join('\n');
}

export const pcgRemoveNodeDescriptor: PyToolDescriptor<typeof pcgRemoveNodeSchema.shape> = {
  name: 'pcg_remove_node',
  description:
    'Remove a node from a PCG graph by title (settings-class name, exact/unambiguous-substring) or index. The node AND all its incident edges are deleted. Returns the surviving node list (index+label). NON-IDEMPOTENT: indices shift after removal, so re-fetch via hayba_export_pcg_graph before further edits. This is the destructive counterpart to pcg_add_node.',
  cost: 'low',
  returns: '{ok, removed, nodes:[{index,label}], node_count}',
  schema: pcgRemoveNodeSchema.shape,
  meta: removeMeta,
  buildScript: removeNodeScript,
  timeoutMs: 30_000,
};

// ── pcg_disconnect (§2b) ──────────────────────────────────────────────────────
// Wraps UPCGGraph::RemoveEdge(From, FromLabel, To, ToLabel) -> bool
// (PCGGraph.h:481, BlueprintCallable) → Python g.remove_edge(a, from_pin, b,
// to_pin). Returns false when no such edge exists — surfaced as an explicit
// error so a no-op is never mistaken for success. Non-idempotent.
export const pcgDisconnectSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  from_node: z.union([z.string(), z.number().int()]).describe('Source node title or index (or "Input" for the graph input node).'),
  from_pin: z.string().optional().default('Out').describe('Source output pin label (default "Out"). Use pcg_list_pins to confirm.'),
  to_node: z.union([z.string(), z.number().int()]).describe('Target node title or index (or "Output" for the graph output node).'),
  to_pin: z.string().optional().default('In').describe('Target input pin label (default "In").'),
});
export type PcgDisconnectParams = z.infer<typeof pcgDisconnectSchema>;

function disconnectScript(p: PcgDisconnectParams): string {
  const from = typeof p.from_node === 'number' ? String(p.from_node) : pyStr(p.from_node);
  const to = typeof p.to_node === 'number' ? String(p.to_node) : pyStr(p.to_node);
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_from = ${from}`,
    `_to = ${to}`,
    `_from_pin = ${pyStr(p.from_pin ?? 'Out')}`,
    `_to_pin = ${pyStr(p.to_pin ?? 'In')}`,
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    a, m = _resolve_node_ext(g, _from)',
    '    if a is None: return _err(m)',
    '    b, m = _resolve_node_ext(g, _to)',
    '    if b is None: return _err(m)',
    '    if not hasattr(g, "remove_edge"): return _err("UPCGGraph.remove_edge not available in this build")',
    '    removed = bool(g.remove_edge(a, _from_pin, b, _to_pin))',
    '    if not removed:',
    '        _emit({"ok": False, "error": "no edge %s.%s -> %s.%s to remove" % (_node_label(a), _from_pin, _node_label(b), _to_pin)})',
    '    else:',
    '        unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '        _emit({"ok": True, "from": _node_label(a), "from_pin": _from_pin, "to": _node_label(b), "to_pin": _to_pin})',
    '_go()',
  ].join('\n');
}

export const pcgDisconnectDescriptor: PyToolDescriptor<typeof pcgDisconnectSchema.shape> = {
  name: 'pcg_disconnect',
  description:
    'Cut a single edge between two PCG nodes: pcg_disconnect(graph, from_node, from_pin, to_node, to_pin). Returns {ok:false, error} if no such edge exists (never a silent no-op). NON-IDEMPOTENT. To delete a whole node and all its wires use pcg_remove_node; to create a wire use pcg_wire.',
  cost: 'low',
  returns: '{ok, from, from_pin, to, to_pin}',
  schema: pcgDisconnectSchema.shape,
  meta: removeMeta,
  buildScript: disconnectScript,
  timeoutMs: 30_000,
};

// ── pcg_layout (§2c) ──────────────────────────────────────────────────────────
// Topological left-to-right (layered/sugiyama) arrange: rank each node by its
// longest path from a source, y-stack nodes that share a rank. Sets positions
// via UPCGNode::SetNodePosition(int32,int32) (PCGNode.h:175, BlueprintCallable,
// WITH_EDITOR). Adjacency is read from each node's output pins' edges: an edge's
// OutputPin is the DOWNSTREAM side (UPCGEdge::OutputPin, PCGEdge.h:42; matches
// the C++ export convention). Idempotent (same layout for same topology).
// GOTCHA: SetNodePosition may not persist if the graph's asset-editor tab is
// open — we save_loaded_asset after, but the tab should be closed for a reload
// to reflect it.
export const pcgLayoutSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  x_spacing: z.number().optional().default(320).describe('Horizontal gap between ranks (default 320).'),
  y_spacing: z.number().optional().default(180).describe('Vertical gap between nodes in a rank (default 180).'),
});
export type PcgLayoutParams = z.infer<typeof pcgLayoutSchema>;

function layoutScript(p: PcgLayoutParams): string {
  return [
    PY_RESOLVE_NODE,
    PY_PIN_HELPERS,
    `_graph = ${pyStr(p.graph)}`,
    `_xs = ${p.x_spacing ?? 320}`,
    `_ys = ${p.y_spacing ?? 180}`,
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    nodes = list(g.nodes)',
    '    n = len(nodes)',
    '    idx = {}',
    '    for i, nd in enumerate(nodes): idx[nd] = i',
    '    succ = [set() for _ in range(n)]',
    '    indeg = [0] * n',
    '    for i, nd in enumerate(nodes):',
    '        for pin in _pins(nd, True):',
    '            edges = list(pin.get_editor_property("edges")) if _has_eprop(pin, "edges") else []',
    '            for e in edges:',
    // shortcut: UPCGEdge.OutputPin is a bare UPROPERTY() that get_editor_property
    // refuses (no Edit/BlueprintVisible), so dn stays None and every node gets rank
    // 0, as before this file dropped try; pair edge objects across pins to fix it.
    '                op = e.get_editor_property("output_pin") if _has_eprop(e, "output_pin") else None',
    '                dn = op.get_editor_property("node") if op is not None and _has_eprop(op, "node") else None',
    '                j = idx.get(dn)',
    '                if j is not None and j != i and j not in succ[i]:',
    '                    succ[i].add(j); indeg[j] += 1',
    '    # Longest-path rank via Kahn topological order (cycle-safe: leftover',
    '    # nodes keep rank 0).',
    '    rank = [0] * n',
    '    from collections import deque as _dq',
    '    q = _dq([i for i in range(n) if indeg[i] == 0])',
    '    _ind = list(indeg)',
    '    seen = 0',
    '    while q:',
    '        i = q.popleft(); seen += 1',
    '        for j in succ[i]:',
    '            if rank[i] + 1 > rank[j]: rank[j] = rank[i] + 1',
    '            _ind[j] -= 1',
    '            if _ind[j] == 0: q.append(j)',
    '    # y-stack: assign each node a row within its rank by encounter order.',
    '    rows = {}',
    '    placed = []',
    '    for i in range(n):',
    '        r = rank[i]',
    '        row = rows.get(r, 0); rows[r] = row + 1',
    '        x = int(r * _xs); y = int(row * _ys)',
    '        nd = nodes[i]',
    // PositionX/PositionY are bare UPROPERTY()s set_editor_property refuses, so
    // set_node_position is the only way to move a node.
    '        if hasattr(nd, "set_node_position"): nd.set_node_position(x, y)',
    '        placed.append({"index": i, "label": _node_label(nd), "x": x, "y": y, "rank": r})',
    '    unreal.EditorAssetLibrary.save_loaded_asset(g)',
    '    _emit({"ok": True, "node_count": n, "ranks": len(rows), "cyclic": seen < n, "nodes": placed, "note": "positions may not reflect until the asset editor tab is closed and the graph reopened"})',
    '_go()',
  ].join('\n');
}

export const pcgLayoutDescriptor: PyToolDescriptor<typeof pcgLayoutSchema.shape> = {
  name: 'pcg_layout',
  description:
    'Auto-arrange a PCG graph left-to-right by dependency (layered/sugiyama: rank = longest path from a source, nodes y-stacked within a rank). Fixes the "every added node piled at (0,0)" mess. Idempotent. NOTE: node positions may only visibly update after the graph\'s asset-editor tab is closed and reopened.',
  cost: 'low',
  returns: '{ok, node_count, ranks, cyclic, nodes:[{index,label,x,y,rank}], note}',
  schema: pcgLayoutSchema.shape,
  meta: lowMeta,
  buildScript: layoutScript,
  timeoutMs: 30_000,
};

// ── pcg_list_pins (§2d) ───────────────────────────────────────────────────────
// Reads UPCGNode::InputPins / OutputPins (PCGNode.h:254,257, BlueprintReadOnly)
// and each pin's FPCGPinProperties.Label / AllowedTypes (PCGPin.h:68,74).
// Read-only — the fix for "guess the pin name, cook drops it silently, re-read
// C++ source". get_name() on a pin is the useless "PCGPin_N"; the visible label
// lives on Properties.Label, which is what this reports.
export const pcgListPinsSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  node: z.union([z.string(), z.number().int()]).describe('Node title (exact/substring) or 0-based index. Also accepts "Input"/"Output" for the graph I/O nodes.'),
});
export type PcgListPinsParams = z.infer<typeof pcgListPinsSchema>;

function listPinsScript(p: PcgListPinsParams): string {
  const nodeRef = typeof p.node === 'number' ? String(p.node) : pyStr(p.node);
  return [
    PY_RESOLVE_NODE,
    PY_PIN_HELPERS,
    `_graph = ${pyStr(p.graph)}`,
    `_node_ref = ${nodeRef}`,
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    node, m = _resolve_node_ext(g, _node_ref)',
    '    if node is None: return _err(m)',
    '    ins = [{"label": _pin_label(pp), "type": _pin_type(pp)} for pp in _pins(node, False)]',
    '    outs = [{"label": _pin_label(pp), "type": _pin_type(pp)} for pp in _pins(node, True)]',
    '    _emit({"ok": True, "node": _node_label(node), "inputs": ins, "outputs": outs})',
    '_go()',
  ].join('\n');
}

export const pcgListPinsDescriptor: PyToolDescriptor<typeof pcgListPinsSchema.shape> = {
  name: 'pcg_list_pins',
  description:
    'List a PCG node\'s input and output pins with their exact labels and allowed types: pcg_list_pins(graph, node) -> {inputs:[{label,type}], outputs:[{label,type}]}. Read-only. Use this BEFORE pcg_wire to get the exact pin label (labels are non-obvious, e.g. the graph Input node\'s output pin is "In", a spline sampler\'s input is "Spline").',
  cost: 'low',
  returns: '{ok, node, inputs:[{label,type}], outputs:[{label,type}]}',
  schema: pcgListPinsSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: listPinsScript,
  timeoutMs: 30_000,
};

// ── pcg_get_node (§2e) ────────────────────────────────────────────────────────
// Full, UNtruncated read of one node's settings — fixes hayba_export_pcg_graph
// truncating long struct strings ("628 chars removed"). With a `path`, walks the
// nested editor-property chain and returns the full value (struct values via
// export_text() when available for exact fidelity). Without a path, dumps every
// readable editor property. Read-only.
export const pcgGetNodeSchema = z.object({
  graph: z.string().min(1).describe('PCG graph asset path'),
  node: z.union([z.string(), z.number().int()]).describe('Node title (exact/substring) or 0-based index.'),
  path: z.string().optional().describe('Optional editor-property path on the node\'s settings, "/"-nested (e.g. "config/fitting/scale_to_fit"). Omit to dump every readable property.'),
});
export type PcgGetNodeParams = z.infer<typeof pcgGetNodeSchema>;

function getNodeScript(p: PcgGetNodeParams): string {
  const nodeRef = typeof p.node === 'number' ? String(p.node) : pyStr(p.node);
  const pathLit = p.path ? pyStr(p.path) : 'None';
  return [
    PY_RESOLVE_NODE,
    `_graph = ${pyStr(p.graph)}`,
    `_node_ref = ${nodeRef}`,
    `_path = ${pathLit}`,
    'def _full(v):',
    '    # Prefer export_text() for structs — exact, untruncated round-trippable.',
    '    return str(v.export_text()) if hasattr(v, "export_text") else str(v)',
    'def _go():',
    '    g, m = _find_graph(_graph)',
    '    if g is None: return _err(m)',
    '    node, m = _resolve_node(g, _node_ref)',
    '    if node is None: return _err(m)',
    '    settings = node.get_settings()',
    '    if _path:',
    '        parts = [s for s in _path.split("/") if s]',
    '        cur = settings',
    '        for seg in parts:',
    '            if not _eprop_ok(cur, seg): return _err("no editor property %r on %s" % (seg, type(cur).__name__))',
    '            cur = cur.get_editor_property(seg)',
    '        _emit({"ok": True, "node": _node_label(node), "path": _path, "type": type(cur).__name__, "value": _full(cur)})',
    '    else:',
    '        props = {}',
    '        for name in dir(settings):',
    '            if name.startswith("_") or not _has_eprop(settings, name): continue',
    '            v = settings.get_editor_property(name)',
    '            if callable(v): continue',
    '            props[name] = _full(v)',
    '        _emit({"ok": True, "node": _node_label(node), "class": type(settings).__name__, "properties": props})',
    '_go()',
  ].join('\n');
}

export const pcgGetNodeDescriptor: PyToolDescriptor<typeof pcgGetNodeSchema.shape> = {
  name: 'pcg_get_node',
  description:
    'Read one PCG node\'s settings FULLY and UNtruncated: pcg_get_node(graph, node, path?). With `path` (\"/\"-nested, e.g. "config/fitting/scale_to_fit") returns that single value in full; without it dumps every readable property. Use when hayba_export_pcg_graph truncates a long struct string. Read-only.',
  cost: 'low',
  returns: '{ok, node, path?, type?, value?} | {ok, node, class, properties:{...}}',
  schema: pcgGetNodeSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: getNodeScript,
  timeoutMs: 30_000,
};

/** Every descriptor in this file, as the other *-py-tools files export theirs (lease-enforcement-contract reads it).
 *  Cast: these descriptors type buildScript's params, which the untyped element type does not accept. */
export const pcgPyDescriptors = [
  pcgAddNodeDescriptor,
  pcgSetPropDescriptor,
  pcgWireDescriptor,
  pcgInspectInstancesDescriptor,
  pcgRemoveNodeDescriptor,
  pcgDisconnectDescriptor,
  pcgLayoutDescriptor,
  pcgListPinsDescriptor,
  pcgGetNodeDescriptor,
] as unknown as PyToolDescriptor[];
