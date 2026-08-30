import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = JSON.parse(readFileSync(join(here, 'sidecar.json'), 'utf8')) as {
  commands: Record<string, { params: Array<{ name: string }>; notes: string }>;
};
const cpp = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPTestHandler.cpp'),
  'utf8',
);
const selectionOps = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPTestSelectionOps.h'),
  'utf8',
);
const buildCpp = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPBuildHandler.cpp'),
  'utf8',
);
const lifecycle = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPTestRunLifecycle.h'),
  'utf8',
);
const isolationPolicy = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPAutomationIsolationPolicy.h'),
  'utf8',
);
const moduleCpp = readFileSync(
  join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'HaybaMCPModule.cpp'),
  'utf8',
);

describe('test_run selection contract', () => {
  it('advertises the same selectors as test_list', () => {
    const listParams = sidecar.commands.test_list!.params.map((p) => p.name);
    const runParams = sidecar.commands.test_run!.params.map((p) => p.name);
    for (const selector of ['filter_pattern', 'filter', 'category']) {
      expect(listParams).toContain(selector);
      expect(runParams).toContain(selector);
    }
  });

  it('shares selector parsing and matching between list and run', () => {
    expect(cpp.match(/ReadTestSelectors\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(cpp.match(/MatchesTestSelectors\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(cpp).toContain('ESearchCase::IgnoreCase');
  });

  it('discovers once, resolves registered names once, and rejects only a pollable overlap', () => {
    const resolver = cpp.slice(
      cpp.indexOf('static FString ResolveRegisteredTestName'),
      cpp.indexOf('static void ReadTestSelectors'),
    );
    expect(resolver).toContain('const TArray<FAutomationTestInfo>& Discovered');
    expect(resolver).not.toContain('CollectAllTests');
    expect(cpp).toContain('S->RegisteredNames[S->Index]');
    expect(cpp).toContain('SeenRegisteredNames');
    expect(cpp).not.toContain('GTestRunActive');
    expect(cpp).toContain('Lease.Reconcile(ActiveJob)');
    expect(cpp).toContain('GetActiveTestRunState().Pin()');
    expect(cpp).toContain('RestoreRunningJob(');
    expect(cpp).toContain('poll build_status { job_id:');
    expect(lifecycle).toContain('Job.Status == EHaybaJobStatus::Running');
    expect(lifecycle).toContain('Job.OpName == TEXT("test_run")');
    expect(lifecycle).toContain('ActiveJobId.Reset()');
  });

  it('fails closed for empty, zero-match, and ambiguous selections', () => {
    const runHandler = cpp.slice(
      cpp.indexOf('static FHaybaHandlerResult Cmd_TestRun'),
      cpp.indexOf('static FHaybaHandlerResult Cmd_TestCancel'),
    );
    expect(selectionOps).toContain('test_run requires test_names');
    expect(selectionOps).toContain('test_run matched no tests');
    expect(selectionOps).toContain('cannot combine filter/category selectors with explicit test_names');
    expect(cpp).toContain('ValidateResolvedSelection');
    expect(cpp).toContain('ValidateCombination');
    expect(sidecar.commands.test_run!.notes).toContain('false green');
    expect(runHandler.indexOf('ValidateResolvedSelection')).toBeLessThan(
      runHandler.indexOf('StartOwnedChildRun('),
    );
  });

  it('defaults every non-allowlisted test to an owned child', () => {
    expect(isolationPolicy).toContain('return EExecutionMode::OwnedChild;');
    expect(isolationPolicy).not.toMatch(/StartsWith|Contains|Hayba\.\*/i);
    expect(cpp).toContain('HaybaAutomationIsolation::Classify(Name)');
    expect(cpp).toContain('StartOwnedChildRun(');
    expect(cpp).toContain('-HaybaAutomationChild=%s');
    expect(cpp).toContain('GAutomationChildOutputLimitChars');
    expect(cpp).toContain('GAutomationChildMaximumTimeoutSeconds');
    expect(sidecar.commands).toHaveProperty('test_cancel');
    expect(moduleCpp).toContain('HaybaAutomationChild=');
    expect(moduleCpp).toContain('!bOwnedAutomationChild && !StartTcpServer()');
    expect(cpp).not.toMatch(/taskkill|Stop-Process|CreateToolhelp32Snapshot/);
    expect(cpp).toContain('FPlatformProcess::TerminateProc(State->Process, true)');
  });

  it('cannot strand the single-flight lease on completion or setup failure', () => {
    const finalize = cpp.slice(cpp.indexOf('static void FinalizeTestRun'), cpp.indexOf('static bool TestRunPump'));
    expect(finalize.indexOf('S->LeaseGuard.Reset()')).toBeLessThan(finalize.indexOf('Journal(Entry)'));
    expect(cpp).toContain('if (!S->TickHandle.IsValid())');
    expect(cpp).toMatch(/if \(!S->TickHandle\.IsValid\(\)\)[\s\S]*?SetDone[\s\S]*?LeaseGuard\.Reset/);
    expect(lifecycle).toContain('~FHaybaMCPTestRunLeaseGuard()');
    expect(lifecycle).toContain('Lease.Release(JobId)');
    expect(cpp).toContain('FHaybaMCPTestHandler::ShutdownActiveRun()');
    expect(moduleCpp).toMatch(/ShutdownModule\(\)[\s\S]*?ShutdownActiveRun\(\)[\s\S]*?StopTcpServer\(\)/);
  });

  it('returns untruncated scalar evidence and fails closed on malformed results', () => {
    const status = sidecar.commands.build_status as unknown as {
      returns: { fields: Array<{ name: string }> };
      notes: string;
    };
    const fields = status.returns.fields.map((field) => field.name);
    for (const name of [
      'passed_count', 'failed_count', 'skipped_count', 'all_passed', 'test_results',
    ]) {
      expect(fields).toContain(name);
    }
    expect(cpp).toContain('Results->SetNumberField(TEXT("passed_count")');
    expect(cpp).toContain('Results->SetBoolField(TEXT("all_passed")');
    expect(buildCpp).toContain('SetObjectField(TEXT("test_results")');
    expect(buildCpp).toContain('produced invalid structured results');
    expect(buildCpp).toContain('Job.ExitCode == 0 && bAllPassed');
    expect(buildCpp).toContain('return Cmd_BuildStatus(Params)');
    expect(buildCpp).not.toContain('FHaybaHandlerResult::Ok(Cmd_BuildStatus(Params))');
    expect(status.notes).toContain('malformed test results fail closed');
  });
});
