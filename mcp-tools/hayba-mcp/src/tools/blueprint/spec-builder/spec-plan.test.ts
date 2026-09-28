import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyGraphPayload, commonAssetRoot, DEFAULT_PROTECTED_ASSET_ROOTS, findTerminals, layoutNodes, livePathProblems, planBuild,
  protectedAssetRoots, resolvePin, rewriteTargetRoot, signatureProblems,
  type BuildPlan, type InspectedNode, type InspectedPin, type PlannedGraph,
} from './spec-plan.js';
import { check } from './spec-check.js';
import { parseSpecText } from './spec-parse.js';
import { sample } from './__fixtures__/sample-spec.js';
import type { BlueprintSpec, FunctionSpec, SpecEntry } from './spec-types.js';

// The protected roots are read from the environment at call time (ruling R6).
// Every test runs with the variable unset, so the default applies, and the
// developer's own value is put back afterwards.
const ROOTS_ENV = 'HAYBA_PROTECTED_ASSET_ROOTS';
let savedRoots: string | undefined;
beforeEach(() => {
  savedRoots = process.env[ROOTS_ENV];
  delete process.env[ROOTS_ENV];
});
afterEach(() => {
  if (savedRoots === undefined) delete process.env[ROOTS_ENV];
  else process.env[ROOTS_ENV] = savedRoots;
});

const errorOf = (r: { name: string } | { error: string }): string => (r as { error: string }).error;

describe('pins, layout and terminals (ported from bpgraph.test.mjs)', () => {
  it('resolvePin: exact, then loose, then the cast "As" shorthand', () => {
    const cast: InspectedPin[] = [
      { name: 'execute', direction: 'input' }, { name: 'Object', direction: 'input' },
      { name: 'then', direction: 'output' }, { name: 'CastFailed', direction: 'output' },
      { name: 'AsPlayer Controller', direction: 'output' }, { name: 'bSuccess', direction: 'output' },
    ];
    expect(resolvePin(cast, 'Object', 'input')).toEqual({ name: 'Object' });
    expect(resolvePin(cast, 'object', 'input')).toEqual({ name: 'Object' });
    expect(resolvePin(cast, 'AsPlayerController', 'output')).toEqual({ name: 'AsPlayer Controller' });
    expect(resolvePin(cast, 'As', 'output', { cast: true })).toEqual({ name: 'AsPlayer Controller' });
    expect(errorOf(resolvePin(cast, 'As', 'output'))).toMatch(/no output pin "As"/);
    const miss = resolvePin(cast, 'Obj', 'input', { cast: true });
    expect(errorOf(miss)).toMatch(/its input pins are "execute", "Object"/);
    expect(errorOf(resolvePin(cast, 'then', 'input'))).toMatch(/no input pin "then"/);
  });

  it('layoutNodes places consumers right of their sources', () => {
    const pos = layoutNodes(['a', 'b', 'c', 'g'], [['a.then', 'b.execute'], ['b.then', 'c.execute'], ['g.V', 'c.X']]);
    expect(pos.a!.x < pos.b!.x && pos.b!.x < pos.c!.x).toBe(true);
    expect(pos.g!.x).toBe(pos.b!.x);
  });

  it('signatureProblems ignores a library function\'s hidden world context and catches real differences', () => {
    // As read live from a BlueprintFunctionLibrary's Twice(In) -> Out.
    const terminals: { entry: { pins: InspectedPin[] }; result: { pins: InspectedPin[] } } = {
      entry: { pins: [{ name: 'then', direction: 'output' }, { name: '__WorldContext', direction: 'output' }, { name: 'In', direction: 'output' }] },
      result: { pins: [{ name: 'execute', direction: 'input' }, { name: 'Out', direction: 'input' }] },
    };
    const twice: FunctionSpec = { name: 'Twice', inputs: [{ name: 'In', type: 'float' }], outputs: [{ name: 'Out', type: 'float' }] };
    expect(signatureProblems(terminals, twice)).toEqual([]);
    expect(signatureProblems(terminals, { ...twice, inputs: [{ name: 'Value', type: 'float' }] })[0]).toMatch(/inputs \[in\], spec says \[value\]/);
    expect(signatureProblems(terminals, { ...twice, outputs: [] })[0]).toMatch(/outputs \[out\], spec says \[\]/);
    expect(signatureProblems({}, twice)[0]).toMatch(/no recognisable entry node/);
  });

  it('findTerminals recognises function entry and result nodes', () => {
    const nodes: InspectedNode[] = [
      { node_id: 'E', title: 'Count Lanterns', pins: [{ name: 'then', direction: 'output' }, { name: 'Room', direction: 'output' }] },
      { node_id: 'X', title: 'Branch', pins: [{ name: 'execute', direction: 'input' }, { name: 'then', direction: 'output' }] },
      { node_id: 'R', title: 'Return Node', pins: [{ name: 'execute', direction: 'input' }, { name: 'Lit', direction: 'input' }] },
    ];
    const t = findTerminals(nodes, 'CountLanterns');
    expect(t.entry!.node_id).toBe('E');
    expect(t.result!.node_id).toBe('R');
    expect(findTerminals(nodes, 'Other', { entry: 'E' }).entry!.node_id).toBe('E');
  });
});

const TARGET = '/Game/HaybaMCPAutomation/SpecBuild';

describe('target_root rewrite', () => {
  const entry = (spec: BlueprintSpec): SpecEntry => ({ file: 'x.json', spec });

  it('finds the common folder of the batch', () => {
    expect(commonAssetRoot(['/Game/A/B/X', '/Game/A/B/UI/Y'])).toBe('/Game/A/B');
    expect(commonAssetRoot(['/Game/A/B/X'])).toBe('/Game/A/B');
  });

  it('compares folder names case-insensitively, keeping the first asset\'s spelling', () => {
    expect(commonAssetRoot(['/Game/Live/Flow/X', '/Game/live/FLOW/UI/Y'])).toBe('/Game/Live/Flow');
    expect(commonAssetRoot(['/Game/Live/Flow/X', '/Game/Live/Other/Y'])).toBe('/Game/Live');
    const [x, y] = rewriteTargetRoot([entry({ asset: '/Game/Live/Flow/X' }), entry({ asset: '/Game/live/FLOW/UI/Y' })], TARGET);
    expect([x!.spec.asset, y!.spec.asset]).toEqual([`${TARGET}/X`, `${TARGET}/UI/Y`]);
  });

  it('rewrites every reference to a batch asset, and nothing else', () => {
    const pc: BlueprintSpec = {
      asset: '/Game/Live/Flow/PC_Main',
      create: { parent: '/Game/PuzzleKit/BP_Base.BP_Base_C' },
      variables: [
        { name: 'Screens', type: 'array<object:/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C>' },
        { name: 'Sfx', type: 'object:/Script/Engine.SoundBase', default: '/Game/Live/Flow/Audio/S_Beep.S_Beep' },
      ],
      graphs: [{
        graph: 'EventGraph',
        nodes: {
          find: { call: 'GetActorOfClass', class: '/Script/Engine.GameplayStatics' },
          mk: { create_widget: '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C' },
          other: { create_widget: '/Game/Live/Flow/UI/WBP_Other.WBP_Other_C' },
        },
        defaults: { 'find.ActorClass': '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C' },
      }],
      cdo_defaults: { ScreenClass: '/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C', Plain: 'WBP_Screen' },
    };
    const screen: BlueprintSpec = { asset: '/Game/Live/Flow/UI/WBP_Screen' };
    const [p, s] = rewriteTargetRoot([entry(pc), entry(screen)], TARGET);
    expect(s!.spec.asset).toBe(`${TARGET}/UI/WBP_Screen`);
    expect(p!.spec.asset).toBe(`${TARGET}/PC_Main`);
    expect(p!.spec.variables![0]!.type).toBe(`array<object:${TARGET}/UI/WBP_Screen.WBP_Screen_C>`);
    expect(p!.spec.variables![1]!.default).toBe('/Game/Live/Flow/Audio/S_Beep.S_Beep');
    const nodes = p!.spec.graphs![0]!.nodes;
    expect(nodes.mk!.create_widget).toBe(`${TARGET}/UI/WBP_Screen.WBP_Screen_C`);
    expect(nodes.other!.create_widget).toBe('/Game/Live/Flow/UI/WBP_Other.WBP_Other_C');
    expect(p!.spec.graphs![0]!.defaults!['find.ActorClass']).toBe(`${TARGET}/UI/WBP_Screen.WBP_Screen_C`);
    expect(p!.spec.cdo_defaults).toEqual({ ScreenClass: `${TARGET}/UI/WBP_Screen.WBP_Screen_C`, Plain: 'WBP_Screen' });
    expect(p!.spec.create!.parent).toBe('/Game/PuzzleKit/BP_Base.BP_Base_C');
    // The input specs are left as they were.
    expect(pc.asset).toBe('/Game/Live/Flow/PC_Main');
    expect(pc.variables![0]!.type).toBe('array<object:/Game/Live/Flow/UI/WBP_Screen.WBP_Screen_C>');
  });

  it('does not rewrite an asset whose name merely starts with a batch asset name', () => {
    const [a] = rewriteTargetRoot([
      entry({ asset: '/Game/Live/Flow/PC_Main', cdo_defaults: { X: '/Game/Live/Flow/PC_Main2.PC_Main2_C' } }),
    ], TARGET);
    expect(a!.spec.cdo_defaults!.X).toBe('/Game/Live/Flow/PC_Main2.PC_Main2_C');
  });

  it('rewrites a batch path spelled in another case, but not a longer path that merely ends with one', () => {
    const [a] = rewriteTargetRoot([
      entry({
        asset: '/Game/Live/Flow/PC_Main',
        cdo_defaults: {
          Cased: '/game/live/flow/pc_main.PC_Main_C',
          Nested: '/Game/Mods/Game/Live/Flow/PC_Main.PC_Main_C',
          Folder: '/Game/Live/Flow/PC_Main/Sub/X.X_C',
        },
      }),
    ], TARGET);
    expect(a!.spec.cdo_defaults).toEqual({
      Cased: `${TARGET}/PC_Main.PC_Main_C`,
      Nested: '/Game/Mods/Game/Live/Flow/PC_Main.PC_Main_C',
      Folder: '/Game/Live/Flow/PC_Main/Sub/X.X_C',
    });
  });

  it('rewrites each reference once, even when a target path spells another batch asset', () => {
    // /Game/A/B/B/X moves to /Game/A/B/X, which is the source path of the other
    // asset; a chained rewrite would move it a second time, onto /Game/A/X.
    const [x, bx] = rewriteTargetRoot([
      entry({ asset: '/Game/A/B/X', cdo_defaults: { Other: '/Game/A/B/B/X.X_C' } }),
      entry({ asset: '/Game/A/B/B/X', cdo_defaults: { Other: '/Game/A/B/X.X_C' } }),
    ], '/Game/A');
    expect(x!.spec.asset).toBe('/Game/A/X');
    expect(bx!.spec.asset).toBe('/Game/A/B/X');
    expect(x!.spec.cdo_defaults!.Other).toBe('/Game/A/B/X.X_C');
    expect(bx!.spec.cdo_defaults!.Other).toBe('/Game/A/X.X_C');
  });
});

describe('live paths', () => {
  // Nothing is protected by default; these tests protect LIVE the way a caller
  // does, through HAYBA_PROTECTED_ASSET_ROOTS, and use the sample spec as an
  // asset of that folder.
  const LIVE = '/Game/Live/Flow';
  const liveSample = (): BlueprintSpec => ({ ...sample(), asset: `${LIVE}/BPC_Sample` });
  beforeEach(() => { process.env[ROOTS_ENV] = LIVE; });

  it('protects nothing when HAYBA_PROTECTED_ASSET_ROOTS is unset', () => {
    delete process.env[ROOTS_ENV];
    expect(DEFAULT_PROTECTED_ASSET_ROOTS).toEqual([]);
    expect(protectedAssetRoots()).toEqual([]);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], false)).toEqual([]);
    expect(planBuild([{ file: 'a', spec: liveSample() }]).errors).toEqual([]);
  });

  it('still refuses a caller-supplied protected root', () => {
    process.env[ROOTS_ENV] = '/Game/Caller/Live';
    const spec: BlueprintSpec = { ...sample(), asset: '/Game/Caller/Live/BPC_Sample' };
    expect(planBuild([{ file: 'a', spec }]).errors.join('\n')).toContain('BPC_Sample is under /Game/Caller/Live, a protected folder');
    expect(planBuild([{ file: 'a', spec }], { targetRoot: TARGET }).errors).toEqual([]);
    expect(planBuild([{ file: 'a', spec }], { allowLivePaths: true }).errors).toEqual([]);
  });

  it('refuses the protected root unless explicitly allowed', () => {
    expect(livePathProblems([`${LIVE}/PC_Lantern`], false)[0]).toContain(`${LIVE}/PC_Lantern is under ${LIVE}, a protected folder`);
    expect(livePathProblems([`${LIVE}/Widgets/WBP_X`], false)).toHaveLength(1);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], true)).toEqual([]);
    expect(livePathProblems([`${TARGET}/PC_Lantern`, `${LIVE}X/Y`], false)).toEqual([]);
  });

  it('reads the protected roots from HAYBA_PROTECTED_ASSET_ROOTS at call time', () => {
    delete process.env[ROOTS_ENV];
    expect(protectedAssetRoots()).toEqual([]);
    expect(protectedAssetRoots()).toEqual(DEFAULT_PROTECTED_ASSET_ROOTS);
    process.env[ROOTS_ENV] = ' /Game/Mine/ , /Game/Other,';
    expect(protectedAssetRoots()).toEqual(['/Game/Mine', '/Game/Other']);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], false)).toEqual([]);
    expect(livePathProblems(['/Game/Mine/BP_X', '/Game/other/sub/BP_Y', '/Game/MineX/BP_Z'], false)).toHaveLength(2);
    expect(livePathProblems(['/Game/Mine/BP_X'], false)[0]).toMatch(/is under \/Game\/Mine,.*HAYBA_PROTECTED_ASSET_ROOTS/);
    process.env[ROOTS_ENV] = '';
    expect(protectedAssetRoots()).toEqual([]);
    expect(livePathProblems([`${LIVE}/PC_Lantern`], false)).toEqual([]);
  });

  it('planBuild refuses a live asset with no target_root', () => {
    const plan = planBuild([{ file: 'a', spec: liveSample() }]);
    expect(plan.errors.join('\n')).toContain(`BPC_Sample is under ${LIVE}`);
    // The sample itself is outside every protected folder, so it may be built in place.
    expect(planBuild([{ file: 'a', spec: sample() }]).errors).toEqual([]);
  });

  it('planBuild refuses a malformed target_root, and one inside a protected root', () => {
    expect(planBuild([{ file: 'a', spec: liveSample() }], { targetRoot: 'Game/Nope' }).errors[0]).toMatch(/target_root "Game\/Nope" must be a \/Game folder path/);
    const errors = planBuild([{ file: 'a', spec: liveSample() }], { targetRoot: `${LIVE}/Copy` }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.startsWith(`${LIVE}/Copy/BPC_Sample is under ${LIVE}`)).toBe(true);
  });
});

describe('planBuild on the sample spec', () => {
  const planned = (): { plan: BuildPlan; graph: (name: string) => PlannedGraph } => {
    const plan = planBuild([{ file: 'a', spec: sample() }], { targetRoot: TARGET });
    return { plan, graph: (name) => plan.assets[0]!.graphs.find((g) => g.graph === name)! };
  };

  it('splits events, terminals and placed nodes', () => {
    const { plan, graph } = planned();
    expect(plan.errors).toEqual([]);
    const eg = graph('EventGraph');
    expect(eg.eventNodes.map((e) => [e.key, e.kind])).toEqual([['bp', 'event'], ['tick', 'custom_event'], ['click', 'bound_event']]);
    expect(eg.eventNodes[2]).toMatchObject({ event: 'OnClicked', target: 'PlayButton' });
    expect(eg.eventNodes[1]!.inputs).toEqual([{ name: 'Amount', type: 'float' }]);
    expect(eg.applyNodes.map((n) => n.kind).sort()).toEqual(['call', 'create_widget', 'select', 'self', 'sequence', 'timer'].sort());
    expect(eg.applyNodes.find((n) => n.key === 'seq')!.count).toBe(3);
    expect(eg.applyNodes.find((n) => n.key === 'w')).toMatchObject({ x: 900, y: 0 });
    expect(eg.linkedEventKeys).toEqual(['bp', 'tick']);
    const twice = graph('Twice');
    expect(twice.terminalKeys).toEqual({ entry: 'entry', result: 'result' });
    expect(twice.applyDefaults).toEqual([{ node: 'mul', pin: 'B', value: '2' }]);
    expect(twice.applyLinks[0]).toEqual({ from_node: 'entry', from_pin: 'then', to_node: 'result', to_pin: 'execute' });
  });

  it('builds an apply_graph payload that references placed events and terminals by id', () => {
    const { plan, graph } = planned();
    const eg = graph('EventGraph');
    const payload = applyGraphPayload(plan.assets[0]!.asset, eg, { bp: 'G-BP', tick: 'G-TICK', click: 'G-CLICK' });
    expect(payload.graph_name).toBe('EventGraph');
    expect(payload.nodes.filter((n) => n.kind === 'existing')).toEqual([
      { key: 'bp', kind: 'existing', node_id: 'G-BP', x: 0, y: 0 },
      { key: 'tick', kind: 'existing', node_id: 'G-TICK', x: 0, y: 0 },
    ]);
    expect(payload.links).toHaveLength(6);
    expect(() => applyGraphPayload(plan.assets[0]!.asset, eg, { tick: 'G-TICK' })).toThrow(/node "bp" has no node id/);
  });
});

describe('node names are looked up as own keys only', () => {
  it('never treats an inherited name such as toString as a declared node', () => {
    // check() refuses these too (spec-check.test.ts); planning re-checks through the
    // same isDeclaredNode, so a spec that skipped check() cannot plan one either.
    const spec = sample();
    const eg = spec.graphs!.find((g) => g.graph === 'EventGraph')!;
    eg.links!.push(['toString.ReturnValue', 'sel.Option 0']);
    eg.defaults!['constructor.A'] = 1;
    const plan = planBuild([{ file: 'a.json', spec }], { targetRoot: TARGET });
    expect(plan.errors).toEqual([
      'a.json: graph EventGraph links[6] (toString.ReturnValue -> sel.Option 0): from node "toString" is not declared in nodes',
      'a.json: graph EventGraph defaults["constructor.A"]: node "constructor" is not declared in nodes',
    ]);
    const g = plan.assets[0]!.graphs.find((x) => x.graph === 'EventGraph')!;
    expect(Object.hasOwn(g.nodeKinds, 'toString')).toBe(false);
    expect(g.specLinks.map((l) => l.from.node)).not.toContain('toString');
    expect(g.applyLinks.map((l) => l.from_node)).not.toContain('toString');
    expect(g.applyDefaults.map((d) => d.node)).not.toContain('constructor');
    expect(plan.totals.links).toBe(15); // the sample's own 6 + 3 + 6; the refused link is not planned
  });

  it('refuses undeclared and malformed endpoints with the same wording as check()', () => {
    const spec = sample();
    const eg = spec.graphs!.find((g) => g.graph === 'EventGraph')!;
    eg.links!.push(['toString.ReturnValue', 'sel.Option 0'], ['me.self', 'ghost.Target'], ['bad', 'w.execute']);
    eg.defaults!['constructor.A'] = 1;
    const refused = [
      'graph EventGraph links[6] (toString.ReturnValue -> sel.Option 0): from node "toString" is not declared in nodes',
      'graph EventGraph links[7] (me.self -> ghost.Target): to node "ghost" is not declared in nodes',
      'graph EventGraph links[8]: "bad" is not "node.Pin"',
      'graph EventGraph defaults["constructor.A"]: node "constructor" is not declared in nodes',
    ];
    expect(check(spec)).toEqual(refused);
    expect(planBuild([{ file: 'a.json', spec }], { targetRoot: TARGET }).errors).toEqual(refused.map((e) => `a.json: ${e}`));
  });

  it('never takes an inherited property of the id map for a placed node id', () => {
    const spec = sample();
    const eg = spec.graphs!.find((g) => g.graph === 'EventGraph')!;
    Object.assign(eg.nodes, { toString: { custom_event: 'Ping' } }); // own key; `eg.nodes.toString =` does not type-check
    eg.links!.push(['toString.then', 'w.execute']);
    const plan = planBuild([{ file: 'a.json', spec }], { targetRoot: TARGET });
    expect(plan.errors).toEqual([]);
    const g = plan.assets[0]!.graphs.find((x) => x.graph === 'EventGraph')!;
    expect(g.nodeKinds.toString).toBe('custom_event');
    expect(g.linkedEventKeys).toEqual(['bp', 'tick', 'toString']);
    const ids = { bp: 'G-BP', tick: 'G-TICK' };
    expect(() => applyGraphPayload(TARGET, g, ids)).toThrow(/node "toString" has no node id/);
    expect(applyGraphPayload(TARGET, g, { ...ids, toString: 'G-PING' }).nodes.find((n) => n.key === 'toString'))
      .toEqual({ key: 'toString', kind: 'existing', node_id: 'G-PING', x: 0, y: 0 });
  });

  it('plans a node named __proto__ like any other', () => {
    const text = JSON.stringify({
      asset: '/Game/Scratch/BP_Proto',
      graphs: [{
        graph: 'EventGraph',
        nodes: { bp: { event: 'ReceiveBeginPlay' }, PROTO: { branch: true } },
        links: [['bp.then', 'PROTO.execute']],
        defaults: { 'PROTO.Condition': true },
      }],
    }).replaceAll('PROTO', '__proto__');
    const plan = planBuild([{ file: 'a.json', spec: parseSpecText(text).value as BlueprintSpec }]);
    expect(plan.errors).toEqual([]);
    const g = plan.assets[0]!.graphs[0]!;
    expect(Object.keys(g.nodeKinds)).toEqual(['bp', '__proto__']);
    expect(g.applyNodes.map((n) => [n.key, n.kind])).toEqual([['__proto__', 'branch']]);
    expect(g.applyLinks).toEqual([{ from_node: 'bp', from_pin: 'then', to_node: '__proto__', to_pin: 'execute' }]);
    expect(g.applyDefaults).toEqual([{ node: '__proto__', pin: 'Condition', value: 'true' }]);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');
const SOURCE = '/Game/LanternPuzzle/Core';
const FILES = [
  'BFL_BeamMath.json', 'BPC_LanternRing.json', 'PC_Lantern.json', 'BP_DoorLight.json', 'GM_LanternPuzzle.json',
  'WBP_Lantern_Toast.graph.json', 'WBP_Lantern_Tally.graph.json', 'WBP_Lantern_Menu.graph.json',
];
// Derived by counting the frozen fixtures: graphs, nodes and links per spec,
// "defaults" entries, event-kind nodes (event/custom_event/bound_event), and
// nodes apply_graph places (everything but events and function entry/result).
// Nodes and links match the fixture README.
const z = { graphs: 0, nodes: 0, links: 0, defaults: 0, events: 0, apply: 0 };
const GOLDEN: Record<string, typeof z> = {
  [`${TARGET}/BFL_BeamMath`]: { graphs: 2, nodes: 33, links: 47, defaults: 15, events: 0, apply: 29 },
  [`${TARGET}/BPC_LanternRing`]: { graphs: 11, nodes: 124, links: 145, defaults: 39, events: 2, apply: 110 },
  [`${TARGET}/PC_Lantern`]: { graphs: 9, nodes: 71, links: 76, defaults: 30, events: 1, apply: 62 },
  [`${TARGET}/BP_DoorLight`]: z,
  [`${TARGET}/GM_LanternPuzzle`]: z,
  [`${TARGET}/Widgets/WBP_Lantern_Toast`]: { graphs: 1, nodes: 7, links: 9, defaults: 3, events: 0, apply: 6 },
  [`${TARGET}/Widgets/WBP_Lantern_Tally`]: { graphs: 6, nodes: 51, links: 56, defaults: 5, events: 0, apply: 43 },
  [`${TARGET}/Widgets/WBP_Lantern_Menu`]: { graphs: 3, nodes: 46, links: 48, defaults: 14, events: 9, apply: 35 },
};

describe('golden plan for the eight synthetic specs under target_root', () => {
  const loadEntries = (): SpecEntry[] => FILES.map((file) => ({ file, spec: parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value as BlueprintSpec }));
  // Planned inside the first test that asks, so it runs with the test's env isolation.
  let cached: BuildPlan | undefined;
  const goldenPlan = (): BuildPlan => (cached ??= planBuild(loadEntries(), { targetRoot: TARGET }));

  it('plans without errors and with the expected totals', () => {
    const plan = goldenPlan();
    expect(plan.errors).toEqual([]);
    expect(plan.totals).toEqual({ assets: 8, graphs: 32, nodes: 332, links: 381, defaults: 106 });
  });

  it.each(Object.entries(GOLDEN))('%s has its golden counts', (asset, want) => {
    const a = goldenPlan().assets.find((x) => x.asset === asset)!;
    expect(a, `${asset} missing from the plan`).toBeDefined();
    const sum = (f: (g: (typeof a.graphs)[number]) => number): number => a.graphs.reduce((n, g) => n + f(g), 0);
    expect({
      graphs: a.graphs.length,
      nodes: sum((g) => Object.keys(g.nodeKinds).length),
      links: sum((g) => g.specLinks.length),
      defaults: sum((g) => g.applyDefaults.length),
      events: sum((g) => g.eventNodes.length),
      apply: sum((g) => g.applyNodes.length),
    }).toEqual(want);
  });

  it('copies the widget blueprints that have no "create" from their live source', () => {
    const plan = goldenPlan();
    const dup = plan.assets.filter((a) => a.duplicateFrom).map((a) => [a.asset, a.duplicateFrom]);
    expect(dup).toEqual([
      [`${TARGET}/Widgets/WBP_Lantern_Toast`, `${SOURCE}/Widgets/WBP_Lantern_Toast`],
      [`${TARGET}/Widgets/WBP_Lantern_Tally`, `${SOURCE}/Widgets/WBP_Lantern_Tally`],
      [`${TARGET}/Widgets/WBP_Lantern_Menu`, `${SOURCE}/Widgets/WBP_Lantern_Menu`],
    ]);
    expect(plan.warnings).toHaveLength(3);
  });

  it('leaves no live reference to a batch asset, and keeps live references to everything else', () => {
    const plan = goldenPlan();
    const text = JSON.stringify(plan.assets.map(({ sourceAsset: _s, duplicateFrom: _d, ...rest }) => rest));
    for (const file of FILES) {
      const live = (parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value as BlueprintSpec).asset;
      expect(new RegExp(`${live.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["./>])`).test(text), `${live} is still referenced`).toBe(false);
    }
    expect(text).toContain(`${SOURCE}/Sounds/`);
    expect(text).toContain(`${SOURCE}/Widgets/WBP_Lantern_Credits.WBP_Lantern_Credits_C`);
    const pc = plan.assets.find((a) => a.asset === `${TARGET}/PC_Lantern`)!;
    expect(pc.components[0]!.class).toBe(`${TARGET}/BPC_LanternRing.BPC_LanternRing_C`);
    const ring = plan.assets.find((a) => a.asset === `${TARGET}/BPC_LanternRing`)!;
    expect(ring.variables.find((v) => v.name === 'SpareToasts')!.type).toBe(`array<object:${TARGET}/Widgets/WBP_Lantern_Toast.WBP_Lantern_Toast_C>`);
  });

  it('carries every cdo_defaults field, rewriting only batch references (values from the frozen fixtures)', () => {
    const cdo = Object.fromEntries(goldenPlan().assets.filter((a) => a.cdoDefaults).map((a) => [a.asset, a.cdoDefaults]));
    expect(cdo).toEqual({
      [`${TARGET}/PC_Lantern`]: { CheatClass: `${SOURCE}/PC_LanternCheats.PC_LanternCheats_C` },
      [`${TARGET}/BP_DoorLight`]: {
        bEnabled: true, NetCullDistanceSquared: 1500, CustomTimeDilation: 1, InitialLifeSpan: 0.25,
        SpawnCollisionHandlingMethod: 'AlwaysSpawn', bCanBeDamaged: false,
      },
      [`${TARGET}/GM_LanternPuzzle`]: {
        PlayerControllerClass: `${TARGET}/PC_Lantern.PC_Lantern_C`,
        HUDClass: '/Game/LanternPuzzle/Hud/BP_PuzzleHud.BP_PuzzleHud_C',
      },
      [`${TARGET}/Widgets/WBP_Lantern_Menu`]: {
        bIsFocusable: true,
        DesiredFocusWidget: { WidgetName: 'PlayButton' },
        Padding: { Left: 24, Top: 12, Right: 24, Bottom: 12 },
      },
    });
  });
});
