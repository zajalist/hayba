import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byRefLiteralWarnings, check, checkAcross, countSpec, isDeclaredNode, NODE_KIND_NAMES, nodeKind } from './spec-check.js';
import { parseSpecText } from './spec-parse.js';
import { sample } from './__fixtures__/sample-spec.js';
import type { BlueprintSpec, GraphSpec } from './spec-types.js';

const clone = <T>(v: T): T => structuredClone(v);
const graph = (spec: BlueprintSpec, name: string): GraphSpec => spec.graphs!.find((g) => g.graph === name)!;
const rejects = (spec: unknown, pattern: RegExp): void => {
  const errors = check(spec);
  expect(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n  ${errors.join('\n  ') || '(no errors)'}`).toBe(true);
};

describe('check (ported from bpgraph.test.mjs)', () => {
  it('accepts a valid spec that uses every node kind', () => {
    expect(check(sample())).toEqual([]);
  });

  it('accepts the same spec as JSON text, with comments', () => {
    const text = `// header comment\n${JSON.stringify(sample(), null, 2).replace('"asset"', '/* the package */ "asset"')}`;
    expect(check(text)).toEqual([]);
  });

  it('rejects an unknown node kind', () => {
    const spec = clone(sample());
    graph(spec, 'EventGraph').nodes.d = { delay: 0.5 };
    rejects(spec, /node "d": unknown node kind "delay"/);
  });

  it('rejects a node with two kinds', () => {
    const spec = clone(sample());
    graph(spec, 'EventGraph').nodes.d = { branch: true, self: true };
    rejects(spec, /node "d": has 2 kind keys/);
  });

  it('rejects a link to an undeclared node', () => {
    const spec = clone(sample());
    graph(spec, 'CheckGlow').links!.push(['s.Output_Get', 'ghost.A']);
    rejects(spec, /to node "ghost" is not declared/);
  });

  it('rejects a link from an undeclared node', () => {
    const spec = clone(sample());
    graph(spec, 'CheckGlow').links!.push(['nobody.ReturnValue', 'cmp.B']);
    rejects(spec, /from node "nobody" is not declared/);
  });

  it('rejects bad "node.Pin" syntax', () => {
    for (const bad of ['brexecute', 'br.', '.execute', 'br.exe.cute', 'br. execute', '1br.execute']) {
      const spec = clone(sample());
      graph(spec, 'CheckGlow').links!.push(['entry.then', bad]);
      rejects(spec, new RegExp(`"${bad.replace(/[.]/g, '\\.')}" is not "node\\.Pin"`));
    }
  });

  it('rejects bad pin syntax in a defaults key', () => {
    const spec = clone(sample());
    graph(spec, 'EventGraph').defaults!['t'] = '1';
    rejects(spec, /defaults\["t"\]: key is not "node\.Pin"/);
  });

  it('rejects a bad type string', () => {
    for (const [type, pattern] of [
      ['vector3', /unknown type 'vector3'/],
      ['obj:/Script/Engine.Actor', /unknown reference kind 'obj'/],
      ['object:Engine.Actor', /needs a full path/],
      ['array<float', /never closes/],
      ['array<array<int>>', /arrays of arrays/],
      ['object:/Game/UI/WBP_Title', /ends in \.Name_C/],
    ] as const) {
      const spec = clone(sample());
      spec.variables!.push({ name: 'Bad', type });
      rejects(spec, pattern);
    }
  });

  it('rejects a bad type in a function signature and a custom event input', () => {
    const spec = clone(sample());
    spec.functions![1].outputs![0].type = 'flaot';
    (graph(spec, 'EventGraph').nodes.tick as { inputs: Array<{ type: string }> }).inputs[0].type = 'numbr';
    rejects(spec, /outputs\[0\]: unknown type 'flaot'/);
    rejects(spec, /inputs\[0\]: unknown type 'numbr'/);
  });

  it('rejects an entry node in the EventGraph', () => {
    const spec = clone(sample());
    graph(spec, 'EventGraph').nodes.entry = { entry: true };
    rejects(spec, /node "entry": entry nodes exist only in function graphs/);
  });

  it('rejects a result node when the function declares no outputs', () => {
    const spec = clone(sample());
    graph(spec, 'CheckGlow').nodes.result = { result: true };
    rejects(spec, /CheckGlow declares no outputs/);
  });

  it('rejects event nodes in a function graph', () => {
    const spec = clone(sample());
    graph(spec, 'Twice').nodes.go = { custom_event: 'Go' };
    rejects(spec, /custom_event nodes live in the EventGraph/);
  });

  it('rejects a graph for an undeclared function', () => {
    const spec = clone(sample());
    spec.graphs!.push({ graph: 'Nope', nodes: { entry: { entry: true } } });
    rejects(spec, /graph Nope: not "EventGraph" and not a function declared/);
  });

  it('rejects duplicate names', () => {
    const spec = clone(sample());
    spec.variables!.push({ name: 'glow', type: 'name' });
    spec.functions!.push({ name: 'ChimeAudio' });
    graph(spec, 'EventGraph').nodes.tock = { custom_event: 'ontick' };
    spec.graphs!.push({ graph: 'twice', nodes: {} });
    rejects(spec, /"glow" duplicates variable "Glow"/);
    rejects(spec, /"ChimeAudio" duplicates component "ChimeAudio"/);
    rejects(spec, /custom event "ontick" is declared twice/);
    rejects(spec, /graph twice: listed twice/);
  });

  it('rejects duplicate node names that JSON.parse would silently merge', () => {
    const text = JSON.stringify(sample()).replace('"g":{"get":"Glow"}', '"g":{"get":"Glow"},"g":{"branch":true}');
    const errors = check(text);
    expect(errors.some((e) => /graphs\[0\]\.nodes: duplicate key "g"/.test(e)), errors.join('\n')).toBe(true);
  });

  it('rejects duplicate parameter names and reserved ones', () => {
    const spec = clone(sample());
    spec.functions![1].outputs!.push({ name: 'in', type: 'float' });
    spec.functions![0].inputs!.push({ name: 'Then', type: 'bool' });
    rejects(spec, /duplicate parameter name "in"/);
    rejects(spec, /"Then" is reserved/);
  });

  it('rejects links that run the wrong way or double-drive a pin', () => {
    const spec = clone(sample());
    const g = graph(spec, 'CheckGlow');
    g.links!.push(['br.execute', 's.execute']);
    g.links!.push(['g.Glow', 'cmp.A']);
    g.links!.push(['entry.then', 'c.execute']);
    g.links!.push(['s.Output_Get', 'entry.then']);
    rejects(spec, /"execute" is an input pin/);
    rejects(spec, /duplicate link/);
    rejects(spec, /exec output entry\.then already drives br\.execute/);
    rejects(spec, /a entry node has no input pins/);
  });

  it('rejects a literal on a pin that is also linked', () => {
    const spec = clone(sample());
    graph(spec, 'CheckGlow').defaults!['cmp.A'] = 'Dim';
    rejects(spec, /defaults\["cmp\.A"\]: the pin is also linked/);
  });

  it('rejects bad shapes and bad class paths', () => {
    rejects({ ...sample(), asset: '/Game/X/BP_Y.BP_Y' }, /asset: must be a package path/);
    rejects({ ...sample(), create: { parent: '/Game/PuzzleKit/BP_KitPlayerController' } }, /create\.parent: a Blueprint class path ends in \.Name_C/);
    rejects({ ...sample(), variabels: [] }, /unknown top-level key "variabels"/);
    const spec = clone(sample());
    graph(spec, 'EventGraph').nodes.seq = { sequence: 1 };
    graph(spec, 'EventGraph').links![0] = ['bp.then', 'seq.execute'];
    rejects(spec, /"sequence" must be the number of outputs, 2\.\.32/);
    expect(check('{"asset": "/Game/X", }')[0]).toMatch(/not valid JSON: trailing comma at line 1/);
  });

  it('checkAcross rejects one asset built by two specs', () => {
    const errors = checkAcross([{ file: 'a.json', spec: sample() }, { file: 'b.json', spec: sample() }]);
    expect(errors[0]).toMatch(/b\.json: asset .* is also built by a\.json/);
  });
});

describe('component template properties (new in the Hayba port)', () => {
  it('accepts scalar properties on a component', () => {
    const spec = clone(sample());
    spec.components![0].properties = { bAutoActivate: false, VolumeMultiplier: 0.5, Sound: '/Game/A/S_Title.S_Title' };
    expect(check(spec)).toEqual([]);
  });

  it('refuses an empty map, a non-identifier name and a non-scalar value', () => {
    const empty = clone(sample());
    (empty.components![0] as { properties: unknown }).properties = {};
    rejects(empty, /components\[0\] \(ChimeAudio\)\.properties: must be a non-empty object/);
    const bad = clone(sample());
    (bad.components![0] as { properties: unknown }).properties = { 'bad name': true, Nested: { a: 1 } };
    rejects(bad, /properties\["bad name"\]: property names are identifiers/);
    rejects(bad, /properties\["Nested"\]: value must be a string, number or boolean/);
  });
});

describe('inherited names (new in the Hayba port)', () => {
  it('never treats an inherited name such as toString as a declared node', () => {
    // bpgraph tested "name in nodes", which an inherited name passes.
    const spec = clone(sample());
    graph(spec, 'EventGraph').links!.push(['toString.ReturnValue', 'sel.Option 0']);
    graph(spec, 'EventGraph').defaults!['constructor.A'] = 1;
    expect(check(spec)).toEqual([
      'graph EventGraph links[6] (toString.ReturnValue -> sel.Option 0): from node "toString" is not declared in nodes',
      'graph EventGraph defaults["constructor.A"]: node "constructor" is not declared in nodes',
    ]);
    expect(isDeclaredNode({}, 'toString')).toBe(false);
    expect(isDeclaredNode('not an object', 'length')).toBe(false);
  });

  it('accepts a node that really is named toString', () => {
    const spec = clone(sample());
    Object.assign(graph(spec, 'EventGraph').nodes, { toString: { custom_event: 'Ping' } }); // own key; `nodes.toString =` does not type-check
    graph(spec, 'EventGraph').links!.push(['toString.then', 'w.execute']);
    expect(check(spec)).toEqual([]);
    expect(isDeclaredNode(graph(spec, 'EventGraph').nodes, 'toString')).toBe(true);
  });

  it('never treats an inherited name as a node kind', () => {
    expect(nodeKind({ toString: true })).toBeNull();
    expect(nodeKind({ constructor: 1, branch: true })).toBe('branch');
    const spec = clone(sample());
    graph(spec, 'EventGraph').nodes.odd = { constructor: 1 };
    rejects(spec, /node "odd": unknown node kind "constructor"/);
  });
});

describe('by-reference literal warnings', () => {
  it('warns about a literal on a known by-reference input', () => {
    const spec = clone(sample());
    const g = graph(spec, 'CheckGlow');
    g.nodes.toText = { call: 'Conv_TextToString', class: '/Script/Engine.KismetTextLibrary' };
    g.defaults = { ...g.defaults, 'toText.InText': 'hi' };
    expect(check(spec)).toEqual([]);
    expect(byRefLiteralWarnings(spec)).toEqual([
      'graph CheckGlow defaults["toText.InText"]: InText is a by-reference input of Conv_TextToString; the editor refuses a literal there — link a variable get into it instead',
    ]);
  });

  it('is silent when nothing is known about the function', () => {
    expect(byRefLiteralWarnings(sample())).toEqual([]);
  });

  it('warns about the K2_ClearAndInvalidateTimerHandle entry, matching the pin case-insensitively', () => {
    const spec = clone(sample());
    const g = graph(spec, 'CheckGlow');
    g.nodes.clearTimer = { call: 'K2_ClearAndInvalidateTimerHandle', class: '/Script/Engine.KismetSystemLibrary' };
    g.defaults = { ...g.defaults, 'clearTimer.handle': 'x' };
    expect(check(spec)).toEqual([]);
    expect(byRefLiteralWarnings(spec)).toEqual([
      'graph CheckGlow defaults["clearTimer.handle"]: handle is a by-reference input of K2_ClearAndInvalidateTimerHandle; the editor refuses a literal there — link a variable get into it instead',
    ]);
  });

  it('accepts an injected byRef map, matching the function name loosely', () => {
    const spec = clone(sample());
    const g = graph(spec, 'CheckGlow');
    g.nodes.custom = { call: 'MyCustomFn', class: '/Script/Engine.KismetSystemLibrary' };
    g.defaults = { ...g.defaults, 'custom.Target': 'literal' };
    expect(check(spec)).toEqual([]);
    expect(byRefLiteralWarnings(spec)).toEqual([]); // the default table knows nothing about MyCustomFn
    const custom = new Map([['mycustomfn', ['Target']]]);
    expect(byRefLiteralWarnings(spec, custom)).toEqual([
      'graph CheckGlow defaults["custom.Target"]: Target is a by-reference input of MyCustomFn; the editor refuses a literal there — link a variable get into it instead',
    ]);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');
// Counted from the frozen files (see the README next to them).
const COUNTS: Record<string, { nodes: number; links: number }> = {
  'BFL_BeamMath.json': { nodes: 33, links: 47 },
  'BPC_LanternRing.json': { nodes: 124, links: 145 },
  'PC_Lantern.json': { nodes: 71, links: 76 },
  'BP_DoorLight.json': { nodes: 0, links: 0 },
  'GM_LanternPuzzle.json': { nodes: 0, links: 0 },
  'WBP_Lantern_Toast.graph.json': { nodes: 7, links: 9 },
  'WBP_Lantern_Tally.graph.json': { nodes: 51, links: 56 },
  'WBP_Lantern_Menu.graph.json': { nodes: 46, links: 48 },
};

describe('the eight synthetic specs', () => {
  it.each(Object.entries(COUNTS))('%s passes check with its node and link counts', (file, want) => {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    expect(check(text)).toEqual([]);
    const spec = parseSpecText(text).value as BlueprintSpec;
    expect(countSpec(spec)).toEqual(want);
    expect(byRefLiteralWarnings(spec)).toEqual([]);
  });

  it('build together without two specs claiming one asset', () => {
    const entries = Object.keys(COUNTS).map((file) => ({ file, spec: parseSpecText(readFileSync(join(FIXTURES, file), 'utf8')).value }));
    expect(checkAcross(entries)).toEqual([]);
  });

  it('cover every node kind, and both line endings', () => {
    const kinds = new Set<string>();
    const endings = new Set<string>();
    for (const file of Object.keys(COUNTS)) {
      const text = readFileSync(join(FIXTURES, file), 'utf8');
      endings.add(text.includes('\r\n') ? 'CRLF' : 'LF');
      const spec = parseSpecText(text).value as BlueprintSpec;
      for (const g of spec.graphs ?? []) for (const node of Object.values(g.nodes)) kinds.add(String(nodeKind(node)));
    }
    expect([...kinds].sort()).toEqual([...NODE_KIND_NAMES].sort());
    expect([...endings].sort()).toEqual(['CRLF', 'LF']);
  });
});
