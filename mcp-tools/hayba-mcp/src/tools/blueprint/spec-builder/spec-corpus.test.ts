// Runs the whole offline pipeline (parse, check, plan, apply payloads) over a
// directory of spec files.
//
// The synthetic fixtures are always run this way. Set HAYBA_BLUEPRINT_SPEC_CORPUS
// to a directory to run a corpus of your own as well, for example specs of a
// real project that cannot live in this repository; with the variable unset
// those tests are skipped. See __fixtures__/synthetic/README.md.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byRefLiteralWarnings, check, checkAcross, countSpec, isObj } from './spec-check.js';
import { parseSpecText } from './spec-parse.js';
import { applyGraphPayload, planBuild, PROTECTED_ASSET_ROOTS_ENV } from './spec-plan.js';
import type { BlueprintSpec, SpecEntry } from './spec-types.js';

const CORPUS_ENV = 'HAYBA_BLUEPRINT_SPEC_CORPUS';
/** Optional file in a corpus directory: { "<spec file>": ["<error class>", ...] }. */
const EXPECTATIONS_FILE = 'corpus-expectations.json';
const TARGET = '/Game/HaybaMCPAutomation/SpecCorpus';

/**
 * The class of a message from check(), checkAcross() or planBuild(): the part
 * of the spec it is about. Undefined for a message that fits no class, which
 * the corpus run reports as a problem of its own.
 */
function errorClass(message: string): string | undefined {
  if (message.startsWith('not valid JSON: ')) return 'json';
  if (message.includes(': duplicate key "')) return 'duplicate-key';
  if (message === 'a spec must be a JSON object' || message.startsWith('unknown top-level key "')) return 'shape';
  if (/^target_root ".*" must be /.test(message)) return 'target-root';
  if (/ is under .+, a protected folder /.test(message)) return 'protected-path';
  if (/: asset .+ is also built by /.test(message)) return 'duplicate-asset';
  const where = /^(asset|create|variables|components|functions|graphs|graph|cdo_defaults)(?=[.:[ ])/.exec(message);
  if (!where) return undefined;
  return where[1] === 'graphs' ? 'graph' : where[1];
}

interface CorpusFile {
  file: string;
  /** Classes of the errors reported for the file, in order; empty when there are none. */
  errorClasses: string[];
  nodes: number;
  links: number;
  byRefWarnings: number;
}
interface CorpusReport {
  files: CorpusFile[];
  /** Specs that passed check() and were planned together. */
  planned: number;
  totals: { assets: number; graphs: number; nodes: number; links: number; defaults: number };
  planWarnings: number;
  /** Everything that fails the run: a crash, an error nobody expected, a message with no class. */
  problems: string[];
}

function inspectCorpus(dir: string): CorpusReport {
  const problems: string[] = [];
  const crash = (what: string, err: unknown): void => {
    problems.push(`${what}: crashed with ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  };

  let expected: Record<string, string[]> = {};
  const expectationsPath = join(dir, EXPECTATIONS_FILE);
  if (existsSync(expectationsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(expectationsPath, 'utf8'));
      if (!isObj(parsed) || !Object.values(parsed).every((v) => Array.isArray(v) && v.every((c) => typeof c === 'string'))) {
        problems.push(`${EXPECTATIONS_FILE}: must be an object of spec file name -> array of error classes`);
      } else expected = parsed as Record<string, string[]>;
    } catch (err) {
      problems.push(`${EXPECTATIONS_FILE}: not valid JSON: ${(err as Error).message}`);
    }
  }
  const allowed = (file: string): string[] => (Object.hasOwn(expected, file) ? expected[file]! : []);
  const files: CorpusFile[] = [];
  /** Report each message that has no class, or a class the file does not expect. */
  const judge = (file: string, messages: string[], strip = ''): void => {
    const classes = files.find((f) => f.file === file)?.errorClasses ?? [];
    for (const raw of messages) {
      if (typeof raw !== 'string' || raw === '') {
        problems.push(`${file}: a message that is not a non-empty string: ${JSON.stringify(raw)}`);
        continue;
      }
      const message = strip && raw.startsWith(strip) ? raw.slice(strip.length) : raw;
      const cls = errorClass(message);
      if (cls === undefined) problems.push(`${file}: message of no known class: ${raw}`);
      else {
        classes.push(cls);
        if (!allowed(file).includes(cls)) problems.push(`${file}: unexpected ${cls} error: ${raw}`);
      }
    }
  };

  const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json') && f !== EXPECTATIONS_FILE).sort();
  for (const file of Object.keys(expected)) if (!names.includes(file)) problems.push(`${EXPECTATIONS_FILE}: names ${file}, which is not in the corpus`);

  const valid: SpecEntry[] = [];
  for (const file of names) {
    const entry: CorpusFile = { file, errorClasses: [], nodes: 0, links: 0, byRefWarnings: 0 };
    files.push(entry);
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (err) {
      crash(`${file}: reading`, err);
      continue;
    }
    // The parser may refuse the text, but only with a SyntaxError.
    let value: unknown;
    let parsed = false;
    try {
      value = parseSpecText(text).value;
      parsed = true;
    } catch (err) {
      if (!(err instanceof SyntaxError)) crash(`${file}: parseSpecText`, err);
    }
    let errors: string[];
    try {
      errors = check(text);
    } catch (err) {
      crash(`${file}: check`, err);
      continue;
    }
    if (!Array.isArray(errors)) {
      problems.push(`${file}: check did not return an array`);
      continue;
    }
    if (!parsed && errors.length === 0) problems.push(`${file}: the text does not parse, but check reported nothing`);
    judge(file, errors);
    if (errors.length > 0 || !isObj(value)) continue;
    const spec = value as unknown as BlueprintSpec;
    try {
      const counts = countSpec(spec);
      entry.nodes = counts.nodes;
      entry.links = counts.links;
      entry.byRefWarnings = byRefLiteralWarnings(spec).length;
    } catch (err) {
      crash(`${file}: countSpec or byRefLiteralWarnings`, err);
      continue;
    }
    valid.push({ file, spec });
  }

  const report: CorpusReport = { files, planned: 0, totals: { assets: 0, graphs: 0, nodes: 0, links: 0, defaults: 0 }, planWarnings: 0, problems };
  /** An expectation that nothing met is out of date; say so. Runs last. */
  const unmet = (): CorpusReport => {
    for (const f of files) {
      for (const cls of allowed(f.file)) {
        if (!f.errorClasses.includes(cls)) problems.push(`${f.file}: ${EXPECTATIONS_FILE} expects an error of class ${cls}, and there is none`);
      }
    }
    return report;
  };
  // Two specs that build one asset cannot be planned together: keep the first.
  let batch = valid;
  try {
    const across = checkAcross(valid);
    for (const message of across) {
      const file = valid.find((e) => message.startsWith(`${e.file}: `))?.file ?? '(corpus)';
      judge(file, [message]);
    }
    const seen = new Set<string>();
    batch = valid.filter((e) => {
      const key = e.spec.asset.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    crash('checkAcross', err);
  }
  if (batch.length === 0) return unmet();
  try {
    const plan = planBuild(batch, { targetRoot: TARGET });
    report.planned = plan.assets.length;
    report.totals = plan.totals;
    report.planWarnings = plan.warnings.length;
    // A spec that passed check() plans without errors.
    for (const message of plan.errors) {
      const owner = batch.find((e) => message.startsWith(`${e.file}: `));
      judge(owner?.file ?? '(plan)', [message], owner ? `${owner.file}: ` : '');
    }
    for (const warning of plan.warnings) {
      if (!/: the spec has no "create", so it is copied from /.test(warning)) problems.push(`(plan): warning of no known class: ${warning}`);
    }
    for (const asset of plan.assets) {
      for (const graph of asset.graphs) {
        // Events and function terminals are placed before apply_graph; give each an id.
        const ids: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const e of graph.eventNodes) ids[e.key] = `id-${e.key}`;
        for (const key of Object.values(graph.terminalKeys)) if (key) ids[key] = `id-${key}`;
        const payload = applyGraphPayload(asset.asset, graph, ids);
        const known = new Set(payload.nodes.map((n) => n.key));
        for (const link of payload.links) {
          if (!known.has(link.from_node) || !known.has(link.to_node)) problems.push(`${asset.asset} graph ${graph.graph}: a link names a node the payload does not carry`);
        }
      }
    }
  } catch (err) {
    crash('planBuild or applyGraphPayload', err);
  }
  return unmet();
}

// planBuild reads the protected roots from the environment; run without the
// developer's own value, as spec-plan.test.ts does.
let savedRoots: string | undefined;
beforeEach(() => {
  savedRoots = process.env[PROTECTED_ASSET_ROOTS_ENV];
  delete process.env[PROTECTED_ASSET_ROOTS_ENV];
});
afterEach(() => {
  if (savedRoots === undefined) delete process.env[PROTECTED_ASSET_ROOTS_ENV];
  else process.env[PROTECTED_ASSET_ROOTS_ENV] = savedRoots;
});

describe('errorClass', () => {
  it('names the part of the spec a message is about', () => {
    expect(errorClass('not valid JSON: trailing comma at line 1, column 21')).toBe('json');
    expect(errorClass('graphs[0].nodes: duplicate key "g"')).toBe('duplicate-key');
    expect(errorClass('unknown top-level key "variabels"')).toBe('shape');
    expect(errorClass('asset: must be a package path like /Game/Dir/BP_Name (no .Name suffix)')).toBe('asset');
    expect(errorClass('create.parent: a Blueprint class path ends in .Name_C, e.g. /Game/Dir/BP_X.BP_X_C')).toBe('create');
    expect(errorClass('variables[2] (Bad): unknown type \'vector3\'')).toBe('variables');
    expect(errorClass('components[0] (Audio).properties: must be a non-empty object of property -> value')).toBe('components');
    expect(errorClass('functions[1] (Twice).outputs[0]: unknown type \'flaot\'')).toBe('functions');
    expect(errorClass('graphs[3]: graph must be "EventGraph" or a declared function name')).toBe('graph');
    expect(errorClass('graph EventGraph node "d": unknown node kind "delay"')).toBe('graph');
    expect(errorClass('graph Twice links[2] (a.b -> c.d): duplicate link')).toBe('graph');
    expect(errorClass('cdo_defaults["bad name"]: property names are identifiers')).toBe('cdo_defaults');
    expect(errorClass('b.json: asset /Game/X/BP_Y is also built by a.json')).toBe('duplicate-asset');
    expect(errorClass('/Game/Live/BP_Y is under /Game/Live, a protected folder (HAYBA_PROTECTED_ASSET_ROOTS) that is never rebuilt by default')).toBe('protected-path');
    expect(errorClass('TypeError: Cannot read properties of undefined')).toBeUndefined();
    expect(errorClass('undefined')).toBeUndefined();
  });
});

describe('the synthetic fixtures as a corpus', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'synthetic');

  it('parses, checks and plans every spec with nothing to report', () => {
    const report = inspectCorpus(FIXTURES);
    expect(report.problems).toEqual([]);
    expect(report.files.map((f) => f.file)).toHaveLength(8);
    expect(report.files.filter((f) => f.errorClasses.length > 0)).toEqual([]);
    expect(report.planned).toBe(8);
    expect(report.totals).toEqual({ assets: 8, graphs: 32, nodes: 332, links: 381, defaults: 106 });
    expect(report.planWarnings).toBe(3);
  });
});

describe('a corpus with broken specs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-spec-corpus-'));
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ asset: '/Game/Scratch/BP_Good', create: { parent: '/Script/Engine.Actor' } }));
    writeFileSync(join(dir, 'twin.json'), JSON.stringify({ asset: '/Game/Scratch/BP_Good' }));
    writeFileSync(join(dir, 'kind.json'), JSON.stringify({
      asset: '/Game/Scratch/BP_Kind',
      graphs: [{ graph: 'EventGraph', nodes: { d: { delay: 0.5 } }, links: [['d.then', 'ghost.execute']] }],
    }));
    writeFileSync(join(dir, 'text.json'), '{"asset": "/Game/Scratch/BP_Text", }');
    writeFileSync(join(dir, 'notes.txt'), 'not a spec, and not read');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports every error nobody expected, by file and class', () => {
    const report = inspectCorpus(dir);
    expect(report.files.map((f) => [f.file, f.errorClasses])).toEqual([
      ['good.json', []],
      ['kind.json', ['graph', 'graph']],
      ['text.json', ['json']],
      ['twin.json', ['duplicate-asset']],
    ]);
    expect(report.problems).toEqual([
      'kind.json: unexpected graph error: graph EventGraph node "d": unknown node kind "delay"; valid kinds: entry, result, event, custom_event, bound_event, call, get, set, branch, sequence, select, self, cast, create_widget, timer',
      'kind.json: unexpected graph error: graph EventGraph links[0] (d.then -> ghost.execute): to node "ghost" is not declared in nodes',
      'text.json: unexpected json error: not valid JSON: trailing comma at line 1, column 36',
      'twin.json: unexpected duplicate-asset error: twin.json: asset /Game/Scratch/BP_Good is also built by good.json',
    ]);
    expect(report.planned).toBe(1);
  });

  it('accepts the errors the corpus declares, and nothing else', () => {
    writeFileSync(join(dir, EXPECTATIONS_FILE), JSON.stringify({
      'kind.json': ['graph'], 'text.json': ['json'], 'twin.json': ['duplicate-asset'],
    }));
    expect(inspectCorpus(dir).problems).toEqual([]);

    writeFileSync(join(dir, EXPECTATIONS_FILE), JSON.stringify({
      'kind.json': ['graph'], 'text.json': ['json'], 'twin.json': ['duplicate-asset'], 'good.json': ['asset'], 'gone.json': ['json'],
    }));
    expect(inspectCorpus(dir).problems).toEqual([
      `${EXPECTATIONS_FILE}: names gone.json, which is not in the corpus`,
      `good.json: ${EXPECTATIONS_FILE} expects an error of class asset, and there is none`,
    ]);
  });
});

const corpusDir = process.env[CORPUS_ENV]?.trim();

describe.skipIf(!corpusDir)(`the corpus in ${CORPUS_ENV}`, () => {
  it('is a directory with at least one *.json spec', () => {
    expect(existsSync(corpusDir!) && statSync(corpusDir!).isDirectory(), `${CORPUS_ENV}=${corpusDir} is not a directory`).toBe(true);
    const specs = readdirSync(corpusDir!).filter((f) => f.toLowerCase().endsWith('.json') && f !== EXPECTATIONS_FILE);
    expect(specs.length, `${corpusDir} holds no *.json file`).toBeGreaterThan(0);
  });

  it('parses, checks and plans every spec without a crash or an unexpected error', () => {
    const report = inspectCorpus(corpusDir!);
    const lines = report.files.map((f) => `  ${f.file}: ${f.errorClasses.length ? `errors [${f.errorClasses.join(', ')}]` : `${f.nodes} nodes, ${f.links} links`}`
      + `${f.byRefWarnings ? `, ${f.byRefWarnings} by-reference literal warnings` : ''}`);
    console.info([
      `${CORPUS_ENV}=${corpusDir}`,
      ...lines,
      `  planned ${report.planned} of ${report.files.length} under ${TARGET}: ${JSON.stringify(report.totals)}, ${report.planWarnings} warnings`,
    ].join('\n'));
    expect(report.problems).toEqual([]);
  });
});
