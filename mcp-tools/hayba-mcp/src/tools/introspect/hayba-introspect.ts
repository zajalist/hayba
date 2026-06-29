import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { runUePythonJson, pyStr } from '../ue-python.js';

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

function buildScript(p: HaybaIntrospectParams): string {
  const target = p.target ? pyStr(p.target) : 'None';
  const graph = p.pcg_graph ? pyStr(p.pcg_graph) : 'None';
  const nodeId = p.node_id ? pyStr(p.node_id) : 'None';
  const settingsClass = p.settings_class ? pyStr(p.settings_class) : 'None';
  const mode = pyStr(p.mode ?? 'auto');

  // The body is a single Python program. It is intentionally defensive: UE's
  // Python reflection surface varies by type, so every probe is wrapped and the
  // tool returns whatever it can discover rather than hard-failing.
  return [
    `_target = ${target}`,
    `_graph = ${graph}`,
    `_node_id = ${nodeId}`,
    `_settings_class = ${settingsClass}`,
    `_mode = ${mode}`,
    'try:',
    '    def _resolve(nm):',
    '        if nm is None: return None',
    '        o = getattr(unreal, nm, None)',
    '        if o is not None: return o',
    '        try: return unreal.load_class(None, nm)',
    '        except Exception: return None',
    '    def _is_enum(o):',
    '        try: return isinstance(o, type) and issubclass(o, unreal.EnumBase)',
    '        except Exception: return False',
    '    def _dump_enum(o):',
    '        members = []',
    '        try:',
    '            for m in o:',
    '                members.append({"name": m.name, "value": int(m.value)})',
    '        except Exception:',
    '            for nm in dir(o):',
    '                if nm.startswith("_"): continue',
    '                try: members.append({"name": nm, "value": int(getattr(o, nm).value)})',
    '                except Exception: pass',
    '        return members',
    '    def _dump_props(o):',
    '        props = []',
    '        for nm in dir(o):',
    '            if nm.startswith("_"): continue',
    '            try:',
    '                attr = getattr(o, nm)',
    '            except Exception:',
    '                continue',
    '            if callable(attr): continue',
    '            props.append({"name": nm, "type": type(attr).__name__})',
    '        return props',
    '    def _pin_labels(pins):',
    '        out = []',
    '        for pin in (pins or []):',
    '            label = None',
    '            for getter in ("get_name",):',
    '                try: label = str(getattr(pin, getter)()); break',
    '                except Exception: pass',
    '            if label is None:',
    '                try: label = str(pin.get_editor_property("properties").label)',
    '                except Exception: label = str(pin)',
    '            out.append(label)',
    '        return out',
    '    def _dump_node_pins(node):',
    '        res = {"input_pins": [], "output_pins": []}',
    '        for attr, key in (("get_input_pins","input_pins"),("get_output_pins","output_pins")):',
    '            try: res[key] = _pin_labels(getattr(node, attr)())',
    '            except Exception: pass',
    '        try: res["settings_class"] = type(node.get_settings()).__name__',
    '        except Exception: pass',
    '        return res',
    '    result = {"ok": True, "mode": _mode}',
    '    if _mode in ("pcg_node",) or (_mode == "auto" and (_graph or _settings_class)):',
    '        result["mode"] = "pcg_node"',
    '        if _settings_class:',
    '            cls = _resolve(_settings_class)',
    '            if cls is None: raise Exception("settings class not found: %s" % _settings_class)',
    '            inst = unreal.new_object(cls)',
    '            pins = {"input_pins": [], "output_pins": []}',
    '            for attr, key in (("default_input_pin_properties","input_pins"),("default_output_pin_properties","output_pins"),("input_pin_properties","input_pins"),("output_pin_properties","output_pins")):',
    '                try:',
    '                    pp = getattr(inst, attr)()',
    '                    pins[key] = [str(getattr(x, "label", x)) for x in pp]',
    '                except Exception: pass',
    '            result["settings_class"] = _settings_class',
    '            result["pins"] = pins',
    '        else:',
    '            g = unreal.load_asset(_graph)',
    '            if g is None: raise Exception("graph not found: %s" % _graph)',
    '            found = None',
    '            for n in g.get_nodes():',
    '                try: title = str(n.get_node_title())',
    '                except Exception: title = ""',
    '                if _node_id is None or title == _node_id or _node_id in title:',
    '                    found = n; break',
    '            if found is None: raise Exception("node not found: %s" % _node_id)',
    '            result.update(_dump_node_pins(found))',
    '    else:',
    '        o = _resolve(_target)',
    '        if o is None: raise Exception("could not resolve: %s" % _target)',
    '        if _mode == "enum" or (_mode == "auto" and _is_enum(o)):',
    '            result["mode"] = "enum"; result["name"] = _target; result["members"] = _dump_enum(o)',
    '        else:',
    '            result["mode"] = "class"; result["name"] = _target; result["properties"] = _dump_props(o)',
    '    _emit(result)',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function haybaIntrospectHandler(params: HaybaIntrospectParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  try {
    const result = await runUePythonJson(buildScript(parsed.data), 30_000);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `hayba_introspect error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}
