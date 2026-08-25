import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommandMock = vi.fn();
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

const conformMock = vi.fn();
vi.mock('../world/terrain-conform.js', () => ({
  conformToGround: (...args: unknown[]) => conformMock(...(args as [])),
}));

const { planBuild } = await import('./plan-execute.js');

const item = (over: Record<string, unknown>) => ({
  kind: 'asset', symbolKind: 'tunnel', index: 0, meta: {}, ...over,
}) as never;

const ROOM = { w: 6, h: 4, center_cm: [0, 0, 0] as [number, number, number] };

beforeEach(() => {
  executeCommandMock.mockReset();
  conformMock.mockReset();
  conformMock.mockResolvedValue({ hits: [], unavailable: 'no editor in test' });
  executeCommandMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'ism_create_actor') return { actor_id: 'ISM_1' };
    if (cmd === 'ism_add_instances') return { added: 4 };
    return {};
  });
});

describe('building a plan', () => {
  it('places a bound role and reports how many', async () => {
    const r = await planBuild({
      plan: { items: [item({ role: 'vent', meta: { emit: 'asset', role: 'vent', at: 'wall_mid' } })] },
      bindings: { vent: '/Game/SM_Vent' },
      room: ROOM,
    });

    expect(r.ok).toBe(true);
    expect(r.built).toEqual([{ roles: ['vent'], asset: '/Game/SM_Vent', instances: 4 }]);
  });

  it('never guesses an asset for an unbound role', async () => {
    const r = await planBuild({
      plan: { items: [item({ role: 'column', meta: { emit: 'asset', role: 'column', along: 'floor_edge' } })] },
      bindings: {},
      room: ROOM,
    });

    // Picking a mesh because its name looked close is how a colonnade ends up
    // made of barrels. The role is named and handed back instead.
    expect(r.unbound).toEqual(['column']);
    expect(r.built).toEqual([]);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('says why it will not build a shell', async () => {
    const r = await planBuild({
      plan: { items: [item({ kind: 'shell', role: 'wall', meta: { emit: 'shell', role: 'wall' } })] },
      bindings: { wall: '/Game/SM_Wall' },
      room: ROOM,
    });

    // A shell is generated geometry. Placing a mesh called "wall" at the room
    // centre would look like it worked and be wrong.
    expect(r.skipped[0]!.reason).toMatch(/generated geometry/);
    expect(r.built).toEqual([]);
  });

  it('says why it will not hang a decal on an arch that does not exist', async () => {
    const r = await planBuild({
      plan: { items: [item({ kind: 'decal', role: 'crack', meta: { emit: 'decal', along: 'arch_crown' } })] },
      bindings: { crack: '/Game/M_Crack' },
      room: ROOM,
    });

    expect(r.skipped[0]!.reason).toMatch(/not built/);
  });

  it('groups two items of the same asset into one ISM actor', async () => {
    const r = await planBuild({
      plan: { items: [
        item({ role: 'rubble', index: 0, kind: 'scatter', tag: 'rubble', meta: { emit: 'scatter', tag: 'rubble' } }),
        item({ role: 'rubble', index: 1, kind: 'scatter', tag: 'rubble', meta: { emit: 'scatter', tag: 'rubble' } }),
      ] },
      bindings: { rubble: '/Game/SM_Rubble' },
      room: ROOM,
    });

    const creates = executeCommandMock.mock.calls.filter(([c]) => c === 'ism_create_actor');
    // One actor per mesh, not per plan item — otherwise a busy room becomes
    // dozens of actors holding one instance each.
    expect(creates).toHaveLength(1);
    expect(r.built).toHaveLength(1);
  });

  it('reports that it could not ground anything rather than implying it did', async () => {
    const r = await planBuild({
      plan: { items: [item({ role: 'vent', meta: { emit: 'asset', at: 'wall_mid' } })] },
      bindings: { vent: '/Game/SM_Vent' },
      room: ROOM,
    });

    expect(r.grounded).toBe(false);
    expect(r.ground_note).toMatch(/no editor/);
  });

  it('grounds each point when the trace runs', async () => {
    conformMock.mockResolvedValue({
      hits: [{ x: 0, y: -200, z: 50 }, { x: 300, y: 0, z: 75 },
             { x: 0, y: 200, z: 90 }, { x: -300, y: 0, z: 120 }],
    });
    let sent: Array<{ location: number[] }> = [];
    executeCommandMock.mockImplementation(async (cmd: string, p: unknown) => {
      if (cmd === 'ism_create_actor') return { actor_id: 'ISM_1' };
      if (cmd === 'ism_add_instances') {
        sent = (p as { transforms: Array<{ location: number[] }> }).transforms;
        return { added: sent.length };
      }
      return {};
    });

    const r = await planBuild({
      plan: { items: [item({ role: 'vent', meta: { emit: 'asset', at: 'wall_mid' } })] },
      bindings: { vent: '/Game/SM_Vent' },
      room: ROOM,
    });

    expect(r.grounded).toBe(true);
    expect(sent.map((t) => t.location[2])).toEqual([50, 75, 90, 120]);
  });

  it('spawns nothing on a dry run but still reports the layout', async () => {
    const r = await planBuild({
      plan: { items: [item({ role: 'vent', meta: { emit: 'asset', at: 'wall_mid' } })] },
      bindings: { vent: '/Game/SM_Vent' },
      room: ROOM,
      dry_run: true,
    });

    expect(r.dry_run).toBe(true);
    expect(r.built[0]!.instances).toBe(4);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('reports a failed spawn instead of claiming success', async () => {
    executeCommandMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'ism_create_actor') return {}; // no actor_id
      return {};
    });

    const r = await planBuild({
      plan: { items: [item({ role: 'vent', meta: { emit: 'asset', at: 'wall_mid' } })] },
      bindings: { vent: '/Game/SM_Vent' },
      room: ROOM,
    });

    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no actor_id/);
  });
});

describe('two roles sharing one mesh', () => {
  it('names both, instead of attributing everything to the last one', async () => {
    // A live run bound column, vent and rubble to the same cube and reported
    // 14 instances of "rubble" — which reads as "no columns were placed".
    const r = await planBuild({
      plan: { items: [
        item({ role: 'column', index: 0, meta: { emit: 'asset', along: 'floor_edge', spacing_m: 3 } }),
        item({ role: 'vent', index: 1, meta: { emit: 'asset', at: 'wall_mid' } }),
      ] },
      bindings: { column: '/Game/SM_Cube', vent: '/Game/SM_Cube' },
      room: ROOM,
    });

    expect(r.built).toHaveLength(1);
    expect(r.built[0]!.roles).toEqual(['column', 'vent']);
  });
});
