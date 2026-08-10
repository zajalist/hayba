import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PYTHON_CRASH_RULES } from '../guards/known-crashers.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const cpp = readFileSync(
  join(
    repo,
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'handlers',
    'HaybaMCPPythonHandler.cpp',
  ),
  'utf8',
);
const cppTest = readFileSync(
  join(
    repo,
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'Tests',
    'HaybaMCPPythonPolicyTest.cpp',
  ),
  'utf8',
);
const connectorShared = readFileSync(join(here, '..', 'asset-sources', 'shared.ts'), 'utf8');
const tsHandler = readFileSync(join(here, 'python-run.ts'), 'utf8');

function tsPairs(): string[] {
  return PYTHON_CRASH_RULES.flatMap((rule) => rule.patterns.map((pattern) => `${rule.code}\0${pattern}`)).sort();
}

function cppPairs(): string[] {
  const table = cpp.match(/static const TArray<FFatalPythonRule> Rules = \{([\s\S]*?)\n\s*\};/)?.[1];
  expect(table, 'native fatal-rule table').toBeDefined();
  return [...table!.matchAll(/\{\s*TEXT\("([^"]+)"\),\s*TEXT\("(HCR-[A-Z]+-\d{3})"\)/g)]
    .map((match) => `${match[2]}\0${match[1]}`)
    .sort();
}

describe('python_run native/TS crash policy contract', () => {
  it('keeps every fatal rule and stable code identical at both boundaries', () => {
    expect(cppPairs()).toEqual(tsPairs());
  });

  it('checks the complete native table only through the pure matcher', () => {
    expect(cpp).toContain('FatalPolicyCasesForTests');
    expect(cppTest).toContain('Handler.FatalPolicyCasesForTests()');
    expect(cppTest).toContain('ExpectPurePolicyRejection');
    const fatalSection = cppTest.slice(
      cppTest.indexOf('bool FHaybaMCPPythonFatalPolicyTest::RunTest'),
      cppTest.indexOf('FHaybaMCPPythonPolicyBoundaryTest'),
    );
    expect(fatalSection).not.toContain('RunPolicyProbe');
    expect(fatalSection).not.toContain('Handler.Handle');
  });

  it('resolves import/from/as aliases lexically at the authoritative native boundary', () => {
    for (const marker of [
      'LexPythonPolicySource',
      'ApplyPythonImportAliasesAt',
      'BuildAliasExpandedPythonCalls',
      'ResolvePythonAliasPath',
      'MaxPythonPolicyExpandedChars',
      'MaxPythonPolicyPathComponents',
    ]) {
      expect(cpp, marker).toContain(marker);
    }
    for (const adversarialScript of [
      'process.abort()',
      'process.kill(process.getpid(), 9)',
      'stop_now = process.abort',
      'process.kill.__call__(process.getpid(), 9)',
      "os.__getattribute__('abort')()",
      "operator.attrgetter('abort')(os)()",
      "pick('abort')(os)()",
      "operator.methodcaller('kill', 123, 9)(os)",
      "f'{os.abort()}'",
      'first_hop = module_alias',
      'second_hop = first_hop',
      'second_hop.kill(123, 9)',
      'wrapped_hop = ((module_alias))',
      'stop_now()',
      'signal_process(123, 9)',
      'runtime.settrace(None)',
      'disable_deadline(None)',
      'clock.sleep(5)',
      'workers.Thread(target=cb).start()',
      "Loader.load_map('/Game/X')",
      "__builtins__['__import__']('sys').settrace(None)",
      "__builtins__['__import__']('os').abort()",
      'except BaseException:',
      'except CatchAll:',
      'except Exception.__base__:',
      'CatchAll = Exception.__base__',
      'except imported.Errors[0]:',
      'except make_exception_type():',
      'except external.CustomError:',
      'def run(Exception):',
      'Recoverable = BaseException',
      'from external import Fatal as Exception',
      'imp = __import__',
      'run_hidden = exec',
      'pick = getattr',
      'mutate = setattr',
      'disable = settrace',
      'pick = object.__getattribute__',
      'pick = type.__getattribute__',
      '(Exception := BaseException)',
      '(Exception,) = (BaseException,)',
      'with resource():',
      'async with resource():',
      "probe.getattr_static(os, 'abort')",
      'members(os)',
      "docs.locate('os.abort')",
      'codec.loads(payload)',
      'from marshal import loads as decode',
      'import types as runtime_types',
      'import pkgutil as packages',
      'import runpy as runner',
      'import importlib.util as loader',
      'from base64 import b64decode as decode',
      'import gc as collector',
      'import traceback',
      'from math import *',
      'from time import *',
      '().__class__.__base__.__subclasses__()',
      "BuiltinImporter.load_module('os')",
      "loader.find_spec('os')",
      '(stop_now := process.abort)()',
      'def stop(fn=process.kill):',
      '(stop_now,) = (process._exit,)',
      '(disable := runtime.settrace)(None)',
      'service.abort()',
      'controller.kill(123, 9)',
      'gate.acquire()\\ngate.acquire()',
      'threading.Event().wait()',
      'items.get()',
      'items.join()',
      'Future.result(pending)',
      'futures.wait(pending)',
    ]) {
      expect(cppTest, adversarialScript).toContain(adversarialScript);
    }
    expect(cppTest).toContain("print('os.abort() is forbidden')");
    expect(cppTest).toContain('worker.kill_switch()');
  });

  it('keeps builtin-alias and exception-proof state in their owning native functions', () => {
    const aliasBuilder = cpp.indexOf('FString BuildAliasExpandedPythonCalls(');
    const dangerousAliases = cpp.indexOf('DangerousBuiltinCallables');
    const reservedPolicy = cpp.indexOf('bool FindReservedPythonRuntimeAccess(');
    const safeExceptions = cpp.indexOf('TSet<FString> SafeExceptionNames');
    const unprovenExceptions = cpp.indexOf('TSet<FString> PermanentlyUnprovenExceptionNames');
    expect(aliasBuilder).toBeGreaterThanOrEqual(0);
    expect(dangerousAliases).toBeGreaterThan(aliasBuilder);
    expect(dangerousAliases).toBeLessThan(reservedPolicy);
    expect(safeExceptions).toBeGreaterThan(reservedPolicy);
    expect(unprovenExceptions).toBeGreaterThan(safeExceptions);
  });

  it('inspects f-string expressions without treating literal or escaped braces as calls', () => {
    expect(cpp).toContain('ExtractPythonFStringExpressions');
    expect(cpp).toContain('MaxPythonPolicyFStringDepth = 16');
    expect(cpp).toContain('MaxPythonPolicyTokens = MaxPythonScriptChars');
    expect(cpp).toContain('MaxPythonPolicyLexedChars = MaxPythonPolicyExpandedChars');
    expect(cpp).toContain('FPythonPolicyLexBudget');
    expect(cpp).toContain('MarkPythonPolicyLexBudgetExceeded');
    expect(cpp).toContain('LexPythonPolicySourceInto');
    expect(cpp).toContain('MaxPythonPolicyAliasWorkChars');
    expect(cpp).toContain('FPythonPolicyAliasBudget');
    expect(cpp).toContain('__hayba_alias_budget_limit__');
    expect(cpp).toContain('__hayba_fstring_nesting_limit__');
    expect(cpp).toContain('f_string_nesting_limit');
    expect(cppTest).toContain("f'{os.abort()}'");
    expect(cppTest).toContain("rf'{os.abort()}'");
    expect(cppTest).toContain("f'os.abort() is literal text'");
    expect(cppTest).toContain("f'{{os.abort() is escaped literal text}}'");
    expect(cppTest).toContain('hostile f-string nesting fails closed without unbounded recursion');
    expect(cppTest).toContain('large nested f-string exhausts the global lex-work budget fail closed');
    expect(cppTest).toContain('growing alias paths exhaust bounded copy work fail closed');
  });

  it('constructs dotted names linearly and bounds every import scan', () => {
    for (const marker of [
      'ReadDottedPythonNameBounded',
      'ComponentCount >= MaxPythonPolicyPathComponents',
      'ComponentChars > MaxPythonPolicyPathChars - NameChars - 1',
      'NameChars > Budget->RemainingCopiedChars',
      'OutName.Reserve(NameChars)',
      'FPythonPolicyAliasBudget ImportScanBudget',
      'Another imported identifier requires a comma',
      'Cursor = FMath::Max(Cursor, AfterImport - 1)',
      'componentized dotted name fails before quadratic FString construction',
      'malformed from-import continuation fails closed without overlapping rescans',
      'Binding.Key == TEXT("*")',
      'wildcard import',
    ]) {
      expect(`${cpp}\n${cppTest}`, marker).toContain(marker);
    }
    expect(cpp).not.toContain('OutName += TEXT(".")');
    expect(cpp).not.toContain('ReadDottedPythonName(');
    expect(cpp).not.toMatch(/ApplyPythonImportAliasesAt\([\s\S]{0,180}AfterImport\)\)/);
  });

  it('bounds both captured streams and reports stable truncation facts', () => {
    for (const marker of [
      'MaxPythonCapturedCharsPerStream = 64 * 1024',
      'class _HaybaBoundedCapture:',
      'if kept: self._hb_parts.append(kept)',
      'stdout_truncated',
      'stderr_truncated',
      'stdout_chars_dropped',
      'stderr_chars_dropped',
      'capture_limit_chars_per_stream',
      'capture_value_policy',
      'FHaybaMCPPythonOutputBoundaryTest',
      'non-primitive value omitted by bounded capture',
      'exception arguments omitted by bounded capture',
      "_hb_user_builtins['print'] = _hb_print",
      'deleted print fallback remains primitive-only',
    ]) {
      expect(`${cpp}\n${cppTest}`, marker).toContain(marker);
    }
    expect(cpp).not.toContain('_hb_io.StringIO()');
    expect(cpp).not.toContain('_sep.join([str(_x) for _x in a])');
    expect(cpp).not.toContain('_hb_tb.format_exc()');
    expect(cpp).not.toContain("getattr(_hb_exception, 'args'");
    expect(cpp).toContain('general safety for arbitrary native extension calls remains #392');
  });

  it('keeps allow_unsafe scoped to the production Tier-3 predicate', () => {
    expect(cpp).toContain('ShouldBlockTier3(Tier, bSettingAllows, bAllowUnsafeOverride)');
    expect(cpp).toContain('policy_blocked [HCR-SANDBOX-001]');
    expect(cppTest).toContain('IsTier3PolicyBlockedForTests(Tier3Script, false, false)');
    expect(cppTest).toContain('IsTier3PolicyBlockedForTests(Tier3Script, false, true)');
    expect(cppTest).toContain('IsTier3PolicyBlockedForTests(Tier3Script, true, false)');
    for (const primitive of [
      'files.remove(target)',
      'files.unlink(target)',
      'files.rename(source, target)',
      'files.replace(source, target)',
      'files.mkdir(target)',
      'files.rmdir(target)',
      'Path(target).write_text(data)',
      'Path(target).write_bytes(data)',
      'Path(target).unlink()',
      'Path(source).rename(target)',
      'Path(source).replace(target)',
      'Path(target).mkdir()',
      'Path(target).rmdir()',
      'Path(target).touch()',
    ]) {
      expect(cppTest).toContain(primitive);
    }
    expect(cpp).toContain('A detected filesystem or subprocess primitive is disabled by default.');
  });

  it('bounds bytecode cooperatively and always restores the trace hook', () => {
    expect(cpp).toContain('MaxPythonExecutionSeconds = 5.0');
    expect(cpp).toContain('_hb_trusted_settrace = _hb_sys.settrace');
    expect(cpp).toContain('_hb_trusted_gettrace = _hb_sys.gettrace');
    expect(cpp).toContain('def _hb_execute_user(');
    expect(cpp).toContain('nonlocal _hb_trace_events');
    expect(cpp).toContain('_hb_set_trace(_hb_trace)');
    expect(cpp).toContain('except _HaybaDeadlineExceeded');
    expect(cpp).toContain('except BaseException as _hb_exception:');
    expect(cpp).toContain('finally:');
    expect(cpp).toContain('_hb_user_globals.clear()');
    expect(cpp).toContain('_hb_collect()');
    expect(cpp).toContain('_hb_set_trace(_hb_previous_trace)');
    expect(cpp).not.toContain('_hb_sys.settrace(None)');
    expect(cpp).toContain("'__name__': '__hayba_user__'");
    expect(cpp).toContain("'__builtins__': _hb_user_builtins");
    expect(cpp.indexOf('_hb_user_globals.clear()')).toBeLessThan(cpp.indexOf('_hb_set_trace(_hb_previous_trace)'));
    expect(cpp).toContain('policy_blocked [HCR-TIME-001]');
    expect(cpp).toContain('Native UE/C-extension calls cannot be interrupted safely');
  });

  it('keeps deadline state private and rejects wrapper/frame tampering lexically', () => {
    for (const marker of [
      'FindReservedPythonRuntimeAccess',
      'attempts to access reserved cooperative-deadline state',
      'can expose the private wrapper module and its execution controls',
      'can traverse into private wrapper frames or module state',
      'can index the copied built-in namespace',
      'can swallow the cooperative deadline exception',
      'is not statically proven Exception-derived',
      'IsProvenSafeExceptionExpression',
      'PermanentlyUnprovenExceptionNames',
      'DangerousBuiltinCallables',
      'BuiltinIdentityRoots',
      'moves arbitrary Python into a killable process',
      'HighRiskDynamicPythonModules',
      'TrustedWrapperPythonModules',
      'ObjectGraphImporterDiscoveryTokens',
      'process-global module used by trusted wrapper setup',
      'broader Python requires the process isolation tracked in #392',
      'runtime.settrace = lambda fn: None',
      'first_hop.settrace = lambda fn: None',
      'host._hb_deadline = 999999999',
      "sys.modules['__main__']._hb_deadline = 999999999",
      "f_back.f_locals['_hb_deadline'] = 999999999",
    ]) {
      expect(`${cpp}\n${cppTest}`, marker).toContain(marker);
    }
    expect(cppTest).toContain("print('_hb_deadline and __main__ are wrapper internals')");
    expect(cppTest).toContain("value = 'sys.settrace = harmless text'");
    expect(cppTest).toContain("print('sys.settrace(None) is rejected when executable')");
    expect(cppTest).toContain("print('__builtins__ is reserved only when executable')");
    expect(cppTest).toContain("print('try: and with resource(): are policy examples, not syntax')");
    expect(cppTest).toContain('# with resource():');
    expect(cppTest).toContain('inspect.getattr_static, pydoc.locate, and pickle.loads are blocked imports');
    expect(cppTest).toContain('# import inspect as probe');
  });

  it('does not hide trusted connector source inside forbidden dynamic exec', () => {
    expect(connectorShared).toContain('const script = body;');
    expect(connectorShared).not.toContain('const script = `exec(');
    expect(tsHandler).not.toContain('export function wrapScriptForPrintRedirect');
  });
});
