// python_run namespace contract (#python-run-comprehension-report).
//
// A field report claimed python_run exec'd user code with SPLIT globals/locals
// dictionaries, and that module-scope comprehensions therefore silently iterated
// an EMPTY sequence instead of raising. A silent zero written into a measurement
// is worse than a crash, so the behaviour is pinned here rather than trusted.
//
// Two layers:
//   1. Source contract — the wrapper must pass exactly ONE namespace mapping to
//      exec(). With one mapping, module scope resolves names through LOAD_NAME
//      into that same dict, and nested comprehension/generator scopes see them as
//      globals. Split mappings behave like a class body: a genexp referencing an
//      enclosing name raises NameError.
//   2. Behavioural contract — the wrapper Python is reconstructed verbatim from
//      the shipped C++ literals and executed under the host CPython with a stub
//      `unreal`, running the exact reported reproduction. No UE editor involved.
//
// The behavioural half skips when no python interpreter is on PATH; the source
// half always runs, so the contract can never silently disappear from CI.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const HANDLER = 'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPPythonHandler.cpp';
const handlerCpp = readFileSync(resolve(root, HANDLER), 'utf8');

/** The region of the C++ handler that assembles the Python wrapper text. */
function wrapperRegion(): string {
  const start = handlerCpp.indexOf('FString Wrapper;');
  const end = handlerCpp.indexOf('FPythonCommandEx RunCmd;', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return handlerCpp.slice(start, end);
}

// Compile-time constants the wrapper interpolates via FString::Printf.
const CPP_CONSTANTS: Record<string, number> = {
  MaxPythonCapturedCharsPerStream: 64 * 1024,
  MaxPythonExecutionSeconds: 5.0,
  PythonDeadlineCheckInterval: 256,
};

function unescapeCppLiteral(literal: string): string {
  return literal.replace(/\\(.)/g, (_m, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/** Apply the printf conversions the wrapper actually uses (%s, %d, %.Nf, %%). */
function applyPrintf(format: string, args: Array<string | number>): string {
  let index = 0;
  return format.replace(/%%|%s|%d|%\.(\d)f/g, (match, precision: string | undefined) => {
    if (match === '%%') return '%';
    const value = args[index++];
    if (match === '%s') return String(value);
    if (match === '%d') return String(Math.trunc(Number(value)));
    return Number(value).toFixed(Number(precision));
  });
}

/** Rebuild the exact Python the handler sends to ExecPythonCommandEx. */
function buildWrapperPython(userScript: string): string {
  const codeB64 = Buffer.from(userScript, 'utf8').toString('base64');
  const statement = /Wrapper \+= (?:FString::Printf\()?TEXT\("((?:\\.|[^"\\])*)"\)(?:,\s*([^;]*?)\))?;/gs;
  let out = '';
  let match: RegExpExecArray | null;
  const region = wrapperRegion();
  while ((match = statement.exec(region)) !== null) {
    const literal = unescapeCppLiteral(match[1]);
    const rawArgs = match[2];
    if (rawArgs === undefined) {
      out += literal;
      continue;
    }
    const args = rawArgs
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a) => {
        if (a === '*CodeB64') return codeB64;
        const constant = CPP_CONSTANTS[a];
        expect(constant, `unmapped C++ printf argument: ${a}`).toBeDefined();
        return constant;
      });
    out += applyPrintf(literal, args);
  }
  expect(out).toContain('_hb_execute_user');
  return out;
}

// Stub just enough of the `unreal` module for the reported reproduction: a level
// with 7 RoadSpline actors, 3 MapPin actors, and 5 unrelated actors.
const PYTHON_HOST_PRELUDE = [
  'import sys, builtins',
  'class _C:',
  '    def __init__(self, n): self._n = n',
  '    def get_name(self): return self._n',
  'class _A:',
  '    def __init__(self, n): self._c = _C(n)',
  '    def get_class(self): return self._c',
  'class _EAS:',
  '    def get_all_level_actors(self):',
  "        return [_A('RoadSpline')] * 7 + [_A('MapPin')] * 3 + [_A('StaticMeshActor')] * 5",
  'class _Unreal:',
  '    EditorActorSubsystem = _EAS',
  '    @staticmethod',
  '    def get_editor_subsystem(cls): return cls()',
  "sys.modules['unreal'] = _Unreal",
].join('\n');

const PYTHON_HOST_EPILOGUE = [
  'import builtins',
  "print('HAYBA_OK', builtins._hayba_ok)",
  "print('HAYBA_OUT_BEGIN')",
  'print(builtins._hayba_out)',
  "print('HAYBA_ERR_BEGIN')",
  'print(builtins._hayba_err)',
].join('\n');

function findPython(): string | undefined {
  for (const candidate of ['python3', 'python', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  return undefined;
}

interface WrapperRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runUserScript(python: string, userScript: string): WrapperRun {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-pyns-'));
  try {
    const file = join(dir, 'wrapper.py');
    writeFileSync(
      file,
      `${PYTHON_HOST_PRELUDE}\n${buildWrapperPython(userScript)}\n${PYTHON_HOST_EPILOGUE}\n`,
      'utf8',
    );
    const run = spawnSync(python, [file], { encoding: 'utf8' });
    expect(run.status, `wrapper host failed: ${run.stderr}`).toBe(0);
    const text = run.stdout;
    const outAt = text.indexOf('HAYBA_OUT_BEGIN');
    const errAt = text.indexOf('HAYBA_ERR_BEGIN');
    return {
      ok: /HAYBA_OK True/.test(text),
      stdout: text.slice(outAt + 'HAYBA_OUT_BEGIN\n'.length, errAt),
      stderr: text.slice(errAt + 'HAYBA_ERR_BEGIN\n'.length),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('python_run executes user code in a single namespace', () => {
  it('passes exactly one namespace mapping to exec()', () => {
    const call = /exec\(compile\((?<compiled>[^)]*)\)\s*,\s*(?<namespaces>[^)]*)\)/.exec(wrapperRegion());
    expect(call, 'wrapper no longer contains an exec(compile(...)) call').not.toBeNull();
    const namespaces = call!.groups!.namespaces.trim();
    // A second mapping here makes module scope behave like a class body: nested
    // comprehension/generator scopes stop seeing module-scope names.
    expect(namespaces).not.toContain(',');
    expect(namespaces.length).toBeGreaterThan(0);
  });

  const python = findPython();
  const behavioural = python ? it : it.skip;

  behavioural('does not silently empty a module-scope comprehension', () => {
    const run = runUserScript(
      python!,
      [
        'import unreal',
        'actors = unreal.EditorActorSubsystem().get_all_level_actors()',
        "roads = [a for a in actors if a.get_class().get_name() == 'RoadSpline']",
        "pins = [a for a in actors if a.get_class().get_name() == 'MapPin']",
        "print(len(roads), 'roads,', len(pins), 'pins')",
      ].join('\n'),
    );
    expect(run.stderr.trim()).toBe('');
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe('7 roads, 3 pins');
  });

  behavioural('lets nested scopes read module-scope names by closure and by global', () => {
    // Generator expressions are still real nested functions on every CPython
    // >= 3.11 (list comprehensions were inlined by PEP 709 in 3.12), so this is
    // the spelling that actually detects a split-namespace regression whichever
    // interpreter runs it.
    const run = runUserScript(
      python!,
      [
        'import unreal',
        'actors = unreal.EditorActorSubsystem().get_all_level_actors()',
        "wanted = 'RoadSpline'",
        'names = [a.get_class().get_name() for a in actors]',
        'gen_count = sum(1 for n in names if n == wanted)',
        'dict_count = len({i: n for i, n in enumerate(names) if n == wanted})',
        'set_count = len({(i, n) for i, n in enumerate(names) if n == wanted})',
        "print(gen_count, dict_count, set_count)",
      ].join('\n'),
    );
    expect(run.stderr.trim()).toBe('');
    expect(run.ok).toBe(true);
    expect(run.stdout.trim()).toBe('7 7 7');
  });

  behavioural('still reports a genuinely undefined name as an error, not as zero', () => {
    const run = runUserScript(
      python!,
      ['values = [x for x in never_defined_anywhere]', 'print(len(values))'].join('\n'),
    );
    expect(run.ok).toBe(false);
    expect(run.stderr).toContain('NameError');
    expect(run.stdout.trim()).toBe('');
  });
});
