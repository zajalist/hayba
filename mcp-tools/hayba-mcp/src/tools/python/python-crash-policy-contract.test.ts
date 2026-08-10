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

  it('directly executes the complete native table with allow_unsafe=true', () => {
    expect(cpp).toContain('FatalPolicyCasesForTests');
    expect(cppTest).toContain('Handler.FatalPolicyCasesForTests()');
    expect(cppTest).toContain('RunPolicyProbe(Handler, Script, true)');
    expect(cppTest).toContain('Retry unchanged: forbidden');
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
    ]) {
      expect(cppTest, adversarialScript).toContain(adversarialScript);
    }
    expect(cppTest).toContain("print('os.abort() is forbidden')");
    expect(cppTest).toContain('first_hop = harmless');
    expect(cppTest).toContain('first_hop = harmless()');
  });

  it('inspects f-string expressions without treating literal or escaped braces as calls', () => {
    expect(cpp).toContain('ExtractPythonFStringExpressions');
    expect(cpp).toContain('MaxPythonPolicyFStringDepth = 16');
    expect(cpp).toContain('MaxPythonPolicyTokens = MaxPythonScriptChars');
    expect(cpp).toContain('MaxPythonPolicyLexedChars = MaxPythonPolicyExpandedChars');
    expect(cpp).toContain('FPythonPolicyLexBudget');
    expect(cpp).toContain('MarkPythonPolicyLexBudgetExceeded');
    expect(cpp).toContain('LexPythonPolicySourceInto');
    expect(cpp).toContain('__hayba_fstring_nesting_limit__');
    expect(cpp).toContain('f_string_nesting_limit');
    expect(cppTest).toContain("f'{os.abort()}'");
    expect(cppTest).toContain("rf'{os.abort()}'");
    expect(cppTest).toContain("f'os.abort() is literal text'");
    expect(cppTest).toContain("f'{{os.abort() is escaped literal text}}'");
    expect(cppTest).toContain('hostile f-string nesting fails closed without unbounded recursion');
    expect(cppTest).toContain('large nested f-string exhausts the global lex-work budget fail closed');
  });

  it('bounds both captured streams and reports stable truncation facts', () => {
    for (const marker of [
      'MaxPythonCapturedCharsPerStream = 64 * 1024',
      'class _HaybaBoundedCapture:',
      'if kept: self._parts.append(kept)',
      'stdout_truncated',
      'stderr_truncated',
      'stdout_chars_dropped',
      'stderr_chars_dropped',
      'capture_limit_chars_per_stream',
      'capture_value_policy',
      'FHaybaMCPPythonOutputBoundaryTest',
      'non-primitive value omitted by bounded capture',
      'exception arguments omitted by bounded capture',
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
  });

  it('bounds bytecode cooperatively and always restores the trace hook', () => {
    expect(cpp).toContain('MaxPythonExecutionSeconds = 5.0');
    expect(cpp).toContain('_hb_sys.settrace(_hb_trace)');
    expect(cpp).toContain('except _HaybaDeadlineExceeded');
    expect(cpp).toContain('except BaseException as _hb_exception:');
    expect(cpp).toContain('finally:');
    expect(cpp).toContain('_hb_sys.settrace(None)');
    expect(cpp).toContain('policy_blocked [HCR-TIME-001]');
    expect(cpp).toContain('Native UE/C-extension calls cannot be interrupted safely');
  });

  it('does not hide trusted connector source inside forbidden dynamic exec', () => {
    expect(connectorShared).toContain('const script = body;');
    expect(connectorShared).not.toContain('const script = `exec(');
    expect(tsHandler).not.toContain('export function wrapScriptForPrintRedirect');
  });
});
