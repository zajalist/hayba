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
    expect(cpp).toContain('except BaseException:');
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
