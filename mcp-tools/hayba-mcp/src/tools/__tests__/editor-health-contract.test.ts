import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fail-closed source contracts for sticky editor_unsafe (ADR-0011, ADR-0007).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const unrealRoot = join(repoRoot, 'unreal');
const toolkitPrivate = join(unrealRoot, 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const toolkitPublic = join(unrealRoot, 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Public');
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');
const rel = (file: string): string => relative(repoRoot, file).split(sep).join('/');

function walkCpp(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'Intermediate' || name === 'Binaries') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkCpp(full, out);
    else if (/\.(cpp|h|hpp|inl)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Blank comments, string, character and raw-string literals, keeping every
 * index and newline, so a code match can be sliced back out of the raw text.
 * A regex strip would let TEXT("/Game/*") open a block comment and swallow code.
 */
function codeOnly(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const ident = /[A-Za-z0-9_]/;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    const prev = src[i - 1] ?? '';
    const prev2 = src[i - 2] ?? '';
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === 'R' && next === '"' && (!ident.test(prev) || (/[LuU8]/.test(prev) && !ident.test(prev2)))) {
      const open = src.indexOf('(', i + 2);
      const delim = open === -1 ? '' : src.slice(i + 2, open);
      const close = open === -1 ? -1 : src.indexOf(`)${delim}"`, open + 1);
      const stop = close === -1 ? n : close + delim.length + 2;
      blank(i + 2, stop - 1);
      i = stop;
      continue;
    }
    if (c === '"' || (c === "'" && !ident.test(prev))) {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** [start, end) of the braced body that follows `signature` in code-only text. */
function bodyRange(code: string, signature: string): [number, number] {
  const start = code.indexOf(signature);
  expect(start, `${signature} not found - was it renamed?`).toBeGreaterThan(-1);
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return [open, k + 1];
  }
  throw new Error(`unbalanced body after ${signature}`);
}

const cppFiles = walkCpp(unrealRoot);

describe('one __except in the plugin tree (ADR-0011)', () => {
  it('scans the whole plugin tree, so an empty scan fails closed', () => {
    expect(cppFiles.length).toBeGreaterThanOrEqual(250);
  });

  it('has exactly one __except and one __try, both in HaybaMCPSeh.cpp', () => {
    const excepts: string[] = [];
    const tries: string[] = [];
    for (const file of cppFiles) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (let k = 0; k < [...code.matchAll(/__except\s*\(/g)].length; k++) excepts.push(rel(file));
      for (let k = 0; k < [...code.matchAll(/\b__try\b/g)].length; k++) tries.push(rel(file));
    }
    const seh = 'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSeh.cpp';
    expect(excepts).toEqual([seh]);
    expect(tries).toEqual([seh]);
  });

  it('ignores prose: a bare-token scan would fail closed on the header comments', () => {
    const header = read(toolkitPublic, 'HaybaMCPSeh.h');
    expect(header).toContain('__except');
    expect(codeOnly(header)).not.toContain('__except');
  });

  it('guards through HaybaSeh::RunGuarded or RunGuardedAt only (both spellings, ADR-0007)', () => {
    let sites = 0;
    for (const file of cppFiles) {
      sites += [...codeOnly(readFileSync(file, 'utf8')).matchAll(/\bHaybaSeh::RunGuarded(?:At)?\s*\(/g)].length;
    }
    // material x3, router x1, python x1 today; T1.3 adds the two test-injection sites.
    expect(sites).toBeGreaterThanOrEqual(5);
  });

  it('declares EHaybaFaultSite at global scope (R-20)', () => {
    const header = codeOnly(read(toolkitPublic, 'HaybaMCPSeh.h'));
    const enumAt = header.indexOf('enum class EHaybaFaultSite');
    expect(enumAt).toBeGreaterThan(-1);
    expect(header.indexOf('namespace HaybaSeh')).toBeGreaterThan(enumAt);
  });

  it('runs every Python command through RunGuardedAt(EHaybaFaultSite::Python', () => {
    const raw = read(toolkitPrivate, 'handlers', 'HaybaMCPPythonHandler.cpp');
    const code = codeOnly(raw);
    expect(raw).toContain('RunGuardedAt(EHaybaFaultSite::Python');
    expect(code).not.toContain('ExecPythonGuarded');
    expect(raw).not.toMatch(/#include\s*<excpt\.h>/);
    expect([...code.matchAll(/ExecPythonCommandEx\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/RunPythonCommandGuarded\(PythonPlugin,/g)]).toHaveLength(5);
  });

  it('records a fault after the guard returned, never from the filter', () => {
    const seh = codeOnly(read(toolkitPrivate, 'HaybaMCPSeh.cpp'));
    const exceptAt = seh.search(/__except\s*\(/);
    expect(seh.slice(exceptAt, seh.indexOf('}', exceptAt))).not.toContain('RecordCaughtFault');
    const [start, end] = bodyRange(seh, 'void RunGuardedAt(');
    const body = seh.slice(start, end);
    const raw = body.indexOf('RunGuardedRaw(');
    const repair = body.indexOf('RepairWorldSwitchState(');
    const record = body.indexOf('FHaybaEditorHealth::RecordCaughtFault(');
    expect(raw).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(raw);
    expect(record).toBeGreaterThan(repair);
    expect([...seh.matchAll(/RecordCaughtFault\(/g)]).toHaveLength(1);
  });

  it('posts the user notification only from the ticker delegate, seam first (R-4)', () => {
    const raw = read(toolkitPrivate, 'HaybaMCPEditorHealth.cpp');
    const code = codeOnly(raw);
    expect([...code.matchAll(/AddNotification\(/g)]).toHaveLength(1);
    expect(code).toContain('CreateStatic(&FHaybaEditorHealth::DeliverUserNotification)');
    const [start, end] = bodyRange(code, 'bool FHaybaEditorHealth::DeliverUserNotification(');
    const body = code.slice(start, end);
    const seam = body.indexOf('ActiveOverride');
    const unattended = body.indexOf('FApp::IsUnattended()');
    const post = body.indexOf('AddNotification(');
    expect(seam).toBeGreaterThan(-1);
    expect(unattended).toBeGreaterThan(seam);
    expect(post).toBeGreaterThan(unattended);
    const rawBody = raw.slice(start, end);
    expect([...rawBody.matchAll(/editor_unsafe: user notified/g)]).toHaveLength(1);
    expect(rawBody.indexOf('editor_unsafe: user notified')).toBeGreaterThan(post);
    const [rs, re] = bodyRange(code, 'void FHaybaEditorHealth::RecordFault(');
    expect(code.slice(rs, re)).not.toContain('AddNotification(');
  });
});
