import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    // Bound to the scheduling state, never resolved through Active() when it fires.
    expect(code).toContain('CreateStatic(&FHaybaEditorHealth::DeliverUserNotification, &S)');
    const [start, end] = bodyRange(code, 'bool FHaybaEditorHealth::DeliverUserNotification(');
    const body = code.slice(start, end);
    expect(body).not.toContain('Active()');
    const seam = body.indexOf('bTestOverride');
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

describe('router gate order and fault branch (ADR-0011)', () => {
  const routerRaw = read(toolkitPrivate, 'HaybaMCPCommandHandler.cpp');
  const router = codeOnly(routerRaw);

  it('checks the unsafe gate after auth and before the lease gate', () => {
    const [open] = bodyRange(router, 'FString FHaybaMCPCommandHandler::ProcessCommandInContext(');
    const auth = router.indexOf('FHaybaMCPSecurityManager::Get().ValidateRequest(', open);
    const unsafe = router.indexOf('HaybaMCPHealth::IsCommandAllowedWhileUnsafe(', open);
    const lease = router.indexOf('Leases.CheckCommand(', open);
    expect(auth).toBeGreaterThan(open);
    expect(unsafe).toBeGreaterThan(auth);
    expect(lease).toBeGreaterThan(unsafe);
  });

  it('never infers a native fault from prose', () => {
    const [start, end] = bodyRange(router, 'FHaybaMCPAdvisorySignals SignalsForError(');
    const body = routerRaw.slice(start, end);
    for (const prose of ['TEXT("seh")', 'TEXT("structured exception")', 'TEXT("session as suspect")']) {
      expect(body).not.toContain(prose);
    }
    for (const code of ['[hcr-native-002]', '[hcr-native-003]', '[hcr-native-004]']) expect(body).toContain(code);
  });

  it('builds router refusals with explicit signals, never SignalsForError', () => {
    const [start, end] = bodyRange(router, 'static FString MakeGateRefusal(');
    const body = router.slice(start, end);
    expect(body).not.toContain('SignalsForError');
    expect(body).toContain('Signals.bEditorUnsafe = Refusal.bEditorUnsafe');
    expect(body).toContain('JsonToString(');
  });

  it('drains the refusal limiter before every Note, at every site (R-18)', () => {
    // Every GateRefusalLimiter().Note( in the router, not only RefuseWhileUnsafe:
    // a gate added later (pie_active, asset_busy, owner_reserved) is checked by
    // the same rule without teaching this test its name.
    const sites = [...router.matchAll(/GateRefusalLimiter\(\)\s*\.\s*Note\(/g)].map((match) => match.index!);
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const site of sites) {
      const before = router.slice(0, site);
      const drain = before.lastIndexOf('LogDrainedGateRefusals();');
      expect(drain, `the Note at offset ${site} has no drain before it`).toBeGreaterThan(-1);
      // Same function: no closing brace at column 0 between the drain and the Note.
      expect(before.slice(drain), `the drain before offset ${site} is in another function`).not.toMatch(/\n\}/);
      // Same branch: nothing but the Note's own declaration follows the drain.
      expect(before.slice(drain).split('\n').length, `the drain is not next to the Note at offset ${site}`).toBeLessThanOrEqual(3);
    }
  });

  it('writes the fault policy code into data on every native_fault_contained reply (spec 4.2)', () => {
    const [start, end] = bodyRange(router, 'static FString MakeNativeFaultContained(');
    // The needles are TEXT("...") literals, which codeOnly blanks: read the raw text.
    const body = routerRaw.slice(start, end);
    expect(body).toContain('TEXT("policy_code"), HaybaMCPHealth::FaultCodeFor(Health.LastCause)');
    expect(body).toContain('TEXT("may_have_executed"), true');
    expect(body).not.toContain('if (Data.IsValid()) Response->SetObjectField(TEXT("data")');
  });
});

describe('python_run reads exception text only from an exact SystemError (R-15)', () => {
  const python = read(toolkitPrivate, 'handlers', 'HaybaMCPPythonHandler.cpp');

  it('reads args once, behind an exact type check, and only a str', () => {
    const typeCheck = python.indexOf('if type(_hb_exception) is _hb_system_error:');
    const argsRead = python.indexOf("BaseException.__getattribute__(_hb_exception, 'args')");
    expect(typeCheck).toBeGreaterThan(-1);
    expect(argsRead).toBeGreaterThan(typeCheck);
    expect(python.split("BaseException.__getattribute__(_hb_exception, 'args')").length - 1).toBe(1);
    expect(python).toContain('type(_hb_args[0]) is str');
    expect(python).toContain('_hb_args[0][:240]');
    expect(python).toContain('_hb_trusted_system_error = SystemError');
    for (const unsafeRead of ["getattr(_hb_exception, 'args'", 'str(_hb_exception)', 'repr(_hb_exception)', '_hb_exception.args']) {
      expect(python, unsafeRead).not.toContain(unsafeRead);
    }
  });

  it('never scans the captured streams for corruption markers', () => {
    const scanAt = python.indexOf('HaybaMCPHealth::FindPythonCorruptionMarker(');
    expect(scanAt).toBeGreaterThan(-1);
    expect(python.split('HaybaMCPHealth::FindPythonCorruptionMarker(').length - 1).toBe(1);
    const [start, end] = bodyRange(codeOnly(python), 'static void CollectInterpreterErrors(');
    const collect = codeOnly(python).slice(start, end);
    expect(collect).toContain('EPythonLogOutputType::Error');
    for (const stream of ['StdOut', 'StdErr']) {
      expect(python, `${stream} must never reach the marker scan`).not.toContain(`InterpreterErrors.Add(${stream})`);
    }
    expect(python).toContain('InterpreterErrors.Add(CorruptionText)');
  });

  it('cleans the hand-over builtin up with the others', () => {
    expect(python).toContain("'_hayba_ok','_hayba_timed_out','_hayba_corruption'");
  });
});

describe('the fault-injection command stays test-only', () => {
  const raw = read(toolkitPrivate, 'handlers', 'HaybaMCPTestHandler.cpp');

  it('is compiled only under WITH_DEV_AUTOMATION_TESTS && PLATFORM_WINDOWS', () => {
    const lines = raw.split(/\r?\n/);
    const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('test_inject_native_fault'));
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const { index } of hits) {
      let guard = '';
      for (let k = index; k >= 0; k--) {
        const text = lines[k].trim();
        if (text.startsWith('#endif')) break;
        if (text.startsWith('#if')) {
          guard = text;
          break;
        }
      }
      expect(guard, `line ${index + 1}`).toBe('#if WITH_DEV_AUTOMATION_TESTS && PLATFORM_WINDOWS');
    }
  });

  it('checks all three guards', () => {
    expect(raw).toContain(
      'IsNativeFaultInjectionAllowed(FHaybaEditorHealth::IsTestOverrideActive(), ConnId, GIsAutomationTesting)',
    );
  });

  it('has no sidecar entry and no TS wrapper', () => {
    const pkg = join(repoRoot, 'mcp-tools', 'hayba-mcp');
    expect(readFileSync(join(pkg, 'src', 'legacy-commands', 'sidecar.json'), 'utf8')).not.toContain('test_inject_native_fault');
    const tsFiles: string[] = [];
    const walkTs = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkTs(full);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) tsFiles.push(full);
      }
    };
    walkTs(join(pkg, 'src'));
    expect(tsFiles.length).toBeGreaterThan(100);
    expect(tsFiles.filter((file) => readFileSync(file, 'utf8').includes('test_inject_native_fault'))).toEqual([]);
  });
});

describe('the unsafe allowlist', () => {
  function setNames(src: string, fn: string): string[] {
    const start = src.indexOf(`inline const TSet<FString>& ${fn}()`);
    expect(start, `${fn}() not found - was it renamed?`).toBeGreaterThan(-1);
    const end = src.indexOf('};', start);
    return [...src.slice(start, end).matchAll(/TEXT\("([^"]+)"\)/g)].map((match) => match[1]!);
  }

  it('never admits Python, PIE, saves, compiles, captures or batch work', () => {
    const sets = read(toolkitPrivate, 'HaybaMCPCommandSets.h');
    const policy = read(toolkitPrivate, 'HaybaMCPHealthPolicy.h');
    const names = [
      ...setNames(sets, 'StatusOnlyCommands'),
      ...setNames(policy, 'UnsafeControlPlaneCommands'),
      ...setNames(policy, 'UnsafeReads'),
    ];
    expect(names).toHaveLength(12 + 3 + 27);
    for (const name of names) {
      expect(name).not.toMatch(
        /^python_|^editor_pie_|^editor_(start|stop)_pie$|save|_compile$|^editor_batch$|^lease_(acquire|renew|adopt)$|^test_run$|^wait_for_|^editor_run_console_command$|^editor_live_compile$|capture|render/,
      );
    }
  });

  it('has no production clear', () => {
    const header = read(toolkitPrivate, 'HaybaMCPEditorHealth.h').replace(
      /#if WITH_DEV_AUTOMATION_TESTS[\s\S]*?#endif/g,
      '',
    );
    expect(codeOnly(header)).not.toMatch(/\b(Clear|Reset|MarkHealthy|SetHealthy|ClearUnsafe)\w*\s*\(/);
    expect(codeOnly(read(toolkitPrivate, 'HaybaMCPEditorHealth.cpp'))).not.toMatch(/bUnsafe\s*\.\s*store\s*\(\s*false/);
  });
});

describe('the crash classifier knows both SEH log forms (ADR-0007)', () => {
  it('attributes the old and the new fault line to HCR-SEH-001', () => {
    const script = join(repoRoot, 'mcp-tools', 'hayba-mcp', 'scripts', 'audit-crash-threat-model.mjs');
    // The script starts with a shebang, which vitest's module transform rejects,
    // so the rule runs in a child Node process that loads it the way the CLI does.
    const probe = [
      `const { RULES } = await import(${JSON.stringify(pathToFileURL(script).href)});`,
      "const rule = RULES.find((candidate) => candidate.threat_id === 'HCR-SEH-001');",
      'const [evidence, ...logs] = JSON.parse(process.argv[1]);',
      'process.stdout.write(JSON.stringify(rule ? logs.map((log) => rule.test(evidence, log)) : null));',
    ].join('\n');
    const verdicts = (evidence: string, ...logs: string[]): unknown => {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify([evidence, ...logs])], {
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout);
    };
    const evidence = 'EXCEPTION_ACCESS_VIOLATION\nUnrealEditor_Core UnrealEditor_Core\nUnrealEditor_Engine\nUnrealEditor_UnrealEd';
    const finder = "FObjectFinders can't be used outside of constructors";
    const oldLog = `${finder}\nSEH guard caught a structured exception in handler for command 'level_load' (id: 1)\nProcessing command: ping`;
    const newLog =
      `${finder}\n[HCR-NATIVE-003] editor_unsafe: native fault 0xC0000005 contained in 'level_load' ` +
      '(id 1, owner local, site dispatch, cause native_fault, frame 9)\nProcessing command: ping';
    expect(verdicts(evidence, oldLog, newLog, `${finder}\nProcessing command: ping`)).toEqual([true, true, false]);
  });
});

describe('editor_batch stops while unsafe (T1 design 13)', () => {
  const batch = codeOnly(read(toolkitPrivate, 'handlers', 'HaybaMCPBatchHandler.cpp'));

  it('checks IsUnsafe() before the lease keep-alive and before Machine->Tick', () => {
    const [start, end] = bodyRange(batch, 'bool Pump(');
    const body = batch.slice(start, end);
    const unsafe = body.indexOf('FHaybaEditorHealth::IsUnsafe()');
    expect(unsafe).toBeGreaterThan(-1);
    expect(body.indexOf('Table.Renew(')).toBeGreaterThan(unsafe);
    expect(body.indexOf('Machine->Tick(')).toBeGreaterThan(unsafe);
  });

  it('FinalizeUnsafe never runs a step, unloads, releases regions or collects garbage', () => {
    const [start, end] = bodyRange(batch, 'void FinalizeUnsafe(');
    const body = batch.slice(start, end);
    for (const call of ['RunStep(', 'ReleaseAll(', 'UnloadAll', 'CollectGarbage(', 'ReleaseRegion(', 'ReleaseEditorLoaderAdapter(']) {
      expect(body).not.toContain(call);
    }
    expect(body).toContain('.Release(S->LeaseToken');
  });

  it('region steps check IsUnsafe() first', () => {
    for (const [signature, firstWork] of [
      ['bool RunRegionLoad(', 'ParseBounds('],
      ['bool RunRegionUnload(', 'P->TryGetStringField('],
    ] as const) {
      const [start, end] = bodyRange(batch, signature);
      const body = batch.slice(start, end);
      const unsafe = body.indexOf('FHaybaEditorHealth::IsUnsafe()');
      expect(unsafe, signature).toBeGreaterThan(-1);
      expect(unsafe, signature).toBeLessThan(body.indexOf(firstWork));
    }
  });
});
