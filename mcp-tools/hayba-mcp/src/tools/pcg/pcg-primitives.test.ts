import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  pcgWireDescriptor,
  pcgRemoveNodeDescriptor,
  pcgDisconnectDescriptor,
  pcgLayoutDescriptor,
  pcgListPinsDescriptor,
  pcgGetNodeDescriptor,
} from './pcg-primitives.js';

// Canned-stdout sender that drives the HAYBA_JSON parse path AND captures the
// last script + last (command, params) sent, so we can assert both the wire
// protocol and the generated python.
function mockStdout(stdout: string): {
  sender: Sender;
  lastScript: () => string;
  lastCmd: () => string;
  lastParams: () => Record<string, unknown>;
} {
  let script = '';
  let cmd = '';
  let params: Record<string, unknown> = {};
  const sender: Sender = (async (c: string, pr: Record<string, unknown>) => {
    cmd = c;
    params = pr;
    script = String((pr as { script?: string }).script ?? '');
    return { id: 'inmem', ok: true, data: { ok: true, stdout, stderr: '' } };
  }) as Sender;
  return { sender, lastScript: () => script, lastCmd: () => cmd, lastParams: () => params };
}

function emit(obj: unknown): string {
  return `noise\nHAYBA_JSON:${JSON.stringify(obj)}\ntrailing`;
}

beforeEach(() => setDefaultSender(undefined as never));

describe('pcg_remove_node', () => {
  it('rejects missing graph (never dispatches)', async () => {
    let dispatched = false;
    setDefaultSender((async () => { dispatched = true; return { id: 'x', ok: true, data: {} }; }) as Sender);
    const res = await makePyToolHandler(pcgRemoveNodeDescriptor)({ node: 0 });
    expect(res.isError).toBe(true);
    expect(dispatched).toBe(false);
  });

  it('routes through python_run and embeds remove_node + a resolvable node ref', async () => {
    const { sender, lastScript, lastCmd } = mockStdout(
      emit({ ok: true, removed: 'PCGSubdivideSettings', nodes: [{ index: 0, label: 'A' }], node_count: 1 }),
    );
    setDefaultSender(sender);
    const res = await makePyToolHandler(pcgRemoveNodeDescriptor)({ graph: '/Game/G', node: 'Subdivide' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, node_count: 1 });
    expect(lastCmd()).toBe('python_run');
    const s = lastScript();
    expect(s).toContain('remove_node');
    expect(s).toContain("_node_ref = 'Subdivide'");
    expect(s).toContain('_resolve_node(g, _node_ref)');
    expect(s).toContain('save_loaded_asset');
  });

  it('passes a numeric index as a bare int, not a quoted string', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, removed: 'x', nodes: [], node_count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(pcgRemoveNodeDescriptor)({ graph: '/Game/G', node: 2 });
    expect(lastScript()).toContain('_node_ref = 2');
  });

  it('is classified NON_IDEMPOTENT', () => {
    expect(NON_IDEMPOTENT.has('pcg_remove_node')).toBe(true);
  });
});

describe('pcg_disconnect', () => {
  it('embeds remove_edge with both node refs and pin labels', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, from: 'A', from_pin: 'Out', to: 'B', to_pin: 'In' }),
    );
    setDefaultSender(sender);
    const res = await makePyToolHandler(pcgDisconnectDescriptor)({
      graph: '/Game/G', from_node: 'A', from_pin: 'Out', to_node: 'B', to_pin: 'In',
    });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('remove_edge');
    expect(s).toContain("_from = 'A'");
    expect(s).toContain("_to = 'B'");
    expect(s).toContain("_from_pin = 'Out'");
    expect(s).toContain("_to_pin = 'In'");
  });

  it('defaults from_pin/to_pin to Out/In', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true }));
    setDefaultSender(sender);
    await makePyToolHandler(pcgDisconnectDescriptor)({ graph: '/Game/G', from_node: 0, to_node: 1 });
    const s = lastScript();
    expect(s).toContain("_from_pin = 'Out'");
    expect(s).toContain("_to_pin = 'In'");
  });

  it('surfaces a no-such-edge no-op as ok:false', async () => {
    setDefaultSender(mockStdout(emit({ ok: false, error: 'no edge A.Out -> B.In to remove' })).sender);
    const res = await makePyToolHandler(pcgDisconnectDescriptor)({
      graph: '/Game/G', from_node: 'A', to_node: 'B',
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).ok).toBe(false);
  });

  it('is classified NON_IDEMPOTENT', () => {
    expect(NON_IDEMPOTENT.has('pcg_disconnect')).toBe(true);
  });
});

describe('pcg_layout', () => {
  it('embeds set_node_position and the default spacings', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, node_count: 3, ranks: 2, cyclic: false, nodes: [] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(pcgLayoutDescriptor)({ graph: '/Game/G' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('set_node_position');
    expect(s).toContain('_xs = 320');
    expect(s).toContain('_ys = 180');
    expect(s).toContain('output_pin');
  });

  it('honors custom spacing', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, node_count: 0, ranks: 0, cyclic: false, nodes: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(pcgLayoutDescriptor)({ graph: '/Game/G', x_spacing: 500, y_spacing: 200 });
    expect(lastScript()).toContain('_xs = 500');
    expect(lastScript()).toContain('_ys = 200');
  });

  it('is idempotent (NOT in NON_IDEMPOTENT)', () => {
    expect(NON_IDEMPOTENT.has('pcg_layout')).toBe(false);
  });
});

describe('pcg_list_pins', () => {
  it('reads pins and returns inputs/outputs', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, node: 'Sampler', inputs: [{ label: 'Spline', type: 'Spline' }], outputs: [{ label: 'Out', type: 'Point' }] }),
    );
    setDefaultSender(sender);
    const res = await makePyToolHandler(pcgListPinsDescriptor)({ graph: '/Game/G', node: 'Sampler' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: true,
      inputs: [{ label: 'Spline' }],
      outputs: [{ label: 'Out' }],
    });
    const s = lastScript();
    expect(s).toContain('input_pins');
    expect(s).toContain('output_pins');
    expect(s).toContain('_pin_label');
    // Uses the graph-I/O-aware resolver so "Input"/"Output" work.
    expect(s).toContain('_resolve_node_ext');
  });

  it('is read-only (NOT in NON_IDEMPOTENT)', () => {
    expect(NON_IDEMPOTENT.has('pcg_list_pins')).toBe(false);
  });
});

describe('pcg_get_node', () => {
  it('walks a nested path and requests the full untruncated value', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, node: 'ShapeGrid', path: 'config/fitting/scale_to_fit', type: 'Name', value: 'Fill' }),
    );
    setDefaultSender(sender);
    const res = await makePyToolHandler(pcgGetNodeDescriptor)({
      graph: '/Game/G', node: 'ShapeGrid', path: 'config/fitting/scale_to_fit',
    });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, value: 'Fill' });
    const s = lastScript();
    expect(s).toContain("_path = 'config/fitting/scale_to_fit'");
    expect(s).toContain('export_text');
    expect(s).toContain('get_editor_property(seg)');
  });

  it('dumps all properties when no path is given', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, node: 'X', class: 'PCGSubdivideSettings', properties: { subdivisions: '4' } }),
    );
    setDefaultSender(sender);
    await makePyToolHandler(pcgGetNodeDescriptor)({ graph: '/Game/G', node: 0 });
    const s = lastScript();
    expect(s).toContain('_path = None');
    expect(s).toContain('for name in dir(settings)');
  });

  it('is read-only (NOT in NON_IDEMPOTENT)', () => {
    expect(NON_IDEMPOTENT.has('pcg_get_node')).toBe(false);
  });
});

describe('pcg_wire loud pin validation (§4)', () => {
  it('generates pin-existence checks before add_edge', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, from: 'A', from_pin: 'Out', to: 'B', to_pin: 'In' }));
    setDefaultSender(sender);
    await makePyToolHandler(pcgWireDescriptor)({ graph: '/Game/G', from_node: 'A', to_node: 'B' });
    const s = lastScript();
    expect(s).toContain('_pin_labels(a, True)');
    expect(s).toContain('_pin_labels(b, False)');
    expect(s).toContain('valid_from_pins');
    expect(s).toContain('valid_to_pins');
    // add_edge must be gated behind the validation (in the else branch).
    expect(s).toContain('add_edge');
  });

  it('surfaces a bad-pin envelope with the valid pin lists', async () => {
    setDefaultSender(
      mockStdout(
        emit({ ok: false, error: "no such source pin 'Nope' on A", valid_from_pins: ['Out'], valid_to_pins: ['In'] }),
      ).sender,
    );
    const res = await makePyToolHandler(pcgWireDescriptor)({
      graph: '/Game/G', from_node: 'A', from_pin: 'Nope', to_node: 'B',
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.valid_from_pins).toEqual(['Out']);
  });
});
