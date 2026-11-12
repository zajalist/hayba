import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'before authoring against an unfamiliar UE class/struct/enum or PCG node — discover its editor-property names, types, enum members, or pin labels in one call instead of N failed trial edits',
  not_when: 'you already know the exact property/pin names',
};

export const schema = z.object({
  target: z.string().min(1).describe(
    'What to introspect. For mode="class"/"enum": a Python-visible name (e.g. "Rotator", "StaticMeshComponent", "ECollisionEnabled") or a full class path. For mode="pcg_node": ignored unless settings_class is omitted.',
  ).optional(),
  mode: z.enum(['class', 'enum', 'pcg_node', 'auto']).optional().default('auto')
    .describe('class = editor properties; enum = member names+values; pcg_node = pin labels of a node; auto = guess from target.'),
  pcg_graph: z.string().optional().describe('PCG graph asset path (mode="pcg_node"). Use with node_id.'),
  node_id: z.string().optional().describe('Node title/name within the PCG graph (mode="pcg_node").'),
  settings_class: z.string().optional().describe('PCG settings class name (e.g. "PCGSurfaceSamplerSettings") — introspect pins WITHOUT an existing graph node.'),
});

export type HaybaIntrospectParams = z.infer<typeof schema>;

// Reflection resolve without getattr (refused by native python_run, as is try): each known name and its
// E-stripped enum form (UE Python drops the leading "E": ECollisionEnabled -> CollisionEnabled) becomes a
// static unreal.<Name> read, as in editor-py-tools' pyResolveType. Only CamelCase identifiers qualify, so
// caller text never becomes code.
function pyResolve(...refs: Array<string | undefined>): string {
  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref) continue;
    for (const n of [ref, ref.length > 1 && ref.startsWith('E') ? ref.slice(1) : '']) {
      if (/^[A-Z][A-Za-z0-9_]*$/.test(n) && !['None', 'True', 'False'].includes(n)) {
        lines.push(`    if nm == ${pyStr(ref)} and hasattr(unreal, "${n}"): return unreal.${n}`);
      }
    }
  }
  return [
    'def _resolve(nm):',
    '    if nm is None: return None',
    ...lines,
    '    if nm.startswith("/"): return unreal.load_class(None, nm)',
    '    return None',
  ].join('\n');
}

function buildScript(p: HaybaIntrospectParams): string {
  const target = p.target ? pyStr(p.target) : 'None';
  const graph = p.pcg_graph ? pyStr(p.pcg_graph) : 'None';
  const nodeId = p.node_id ? pyStr(p.node_id) : 'None';
  const settingsClass = p.settings_class ? pyStr(p.settings_class) : 'None';
  const mode = pyStr(p.mode ?? 'auto');

  // The body is a single Python program with no try/with/getattr (native python_run refuses them).
  // Expected misses go through _err; reflection is read from the type docstring, which lists every
  // exported property, inherited too, as "- ``name`` (Type):  [Read-Only|Read-Write] ..."
  // (get_editor_property reads all of them, hasattr only the Blueprint-visible ones). Anything
  // unexpected propagates and runUePythonJson reports it.
  return [
    `_target = ${target}`,
    `_graph = ${graph}`,
    `_node_id = ${nodeId}`,
    `_settings_class = ${settingsClass}`,
    `_mode = ${mode}`,
    pyResolve(p.target, p.settings_class),
    'def _prop(o, n):',
    '    return o.get_editor_property(n) if ("- ``%s`` " % n) in (type(o).__doc__ or "") else None',
    'def _is_enum(o):',
    '    return isinstance(o, type) and hasattr(unreal, "EnumBase") and issubclass(o, unreal.EnumBase)',
    'def _dump_enum(o):',
    '    # UE enum types iterate their entries; a non-iterable target lists no members.',
    '    return [{"name": m.name, "value": int(m.value)} for m in o] if hasattr(type(o), "__iter__") else []',
    'def _dump_props(o):',
    '    props = []',
    '    for ln in ((o if isinstance(o, type) else type(o)).__doc__ or "").splitlines():',
    '        ln = ln.strip()',
    '        if not ln.startswith("- ``"): continue',
    '        nm, _, rest = ln[4:].partition("``")',
    '        rest = rest.strip()',
    '        props.append({"name": nm, "type": rest[1:].partition(")")[0] if rest.startswith("(") else None})',
    '    return props',
    'def _pin_labels(pins):',
    '    out = []',
    '    for pin in (pins or []):',
    '        # pin.properties.label is the meaningful label; get_name() returns "PCGPin_N".',
    '        pp = _prop(pin, "properties")',
    '        lb = _prop(pp, "label") if pp is not None else None',
    '        label = str(lb) if lb is not None else None',
    '        if not label: label = str(pin.get_name()) if hasattr(pin, "get_name") else str(pin)',
    '        out.append(label)',
    '    return out',
    'def _nlabel(n):',
    '    t = str(_prop(n, "node_title"))',
    '    if t and t != "None": return t',
    '    return type(n.get_settings()).__name__ if hasattr(n, "get_settings") else "node"',
    'def _dump_node_pins(node):',
    '    res = {"input_pins": _pin_labels(_prop(node, "input_pins")),',
    '           "output_pins": _pin_labels(_prop(node, "output_pins")), "node_label": _nlabel(node)}',
    '    if hasattr(node, "get_settings"): res["settings_class"] = type(node.get_settings()).__name__',
    '    return res',
    'result = {"ok": True, "mode": _mode}',
    '_fail = None',
    'if _mode in ("pcg_node",) or (_mode == "auto" and (_graph or _settings_class)):',
    '    result["mode"] = "pcg_node"',
    '    if _settings_class:',
    '        cls = _resolve(_settings_class)',
    '        if cls is None:',
    '            _fail = "settings class not found: %s" % _settings_class',
    '        else:',
    '            # Build a throwaway in-memory graph + node to read its real pins',
    '            # (settings alone do not expose pins; the NODE does).',
    '            tg = unreal.new_object(unreal.PCGGraph)',
    '            r = tg.add_node_of_type(cls)',
    '            node = r[0] if isinstance(r, tuple) else r',
    '            result["settings_class"] = _settings_class',
    '            result.update(_dump_node_pins(node))',
    '    else:',
    '        g = unreal.load_asset(_graph) if _graph and unreal.EditorAssetLibrary.does_asset_exist(_graph) else None',
    '        if g is None:',
    '            _fail = "graph not found: %s" % _graph',
    '        elif not isinstance(g, unreal.PCGGraph):',
    '            _fail = "not a PCGGraph: %s" % _graph',
    '        else:',
    '            found = None',
    '            for n in g.nodes:',
    '                lbl = _nlabel(n)',
    '                if _node_id is None or lbl == _node_id or _node_id in lbl:',
    '                    found = n; break',
    '            if found is None: _fail = "node not found: %s" % _node_id',
    '            else: result.update(_dump_node_pins(found))',
    'else:',
    '    o = _resolve(_target)',
    '    if o is None:',
    '        _fail = "could not resolve: %s" % _target',
    '    elif _mode == "enum" or (_mode == "auto" and _is_enum(o)):',
    '        result["mode"] = "enum"; result["name"] = _target; result["members"] = _dump_enum(o)',
    '    else:',
    '        result["mode"] = "class"; result["name"] = _target; result["properties"] = _dump_props(o)',
    'if _fail is not None: _err(_fail)',
    'else: _emit(result)',
  ].join('\n');
}

export const introspectDescriptor: PyToolDescriptor<typeof schema.shape> = {
  name: 'hayba_introspect',
  description:
    'Introspect UE reflection: editor-property names+types of a class/struct, member values of an enum, or input/output pin labels of a PCG node (by graph+node) or settings class. Kills trial-and-error API discovery.',
  cost: 'low',
  returns: '{ok, mode, name?, properties?:[{name,type}], members?:[{name,value}], pins?, input_pins?, output_pins?, settings_class?}',
  schema: schema.shape,
  meta,
  buildScript,
  timeoutMs: 30_000,
};
