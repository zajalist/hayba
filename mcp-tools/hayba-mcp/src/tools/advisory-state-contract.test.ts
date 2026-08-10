import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const toolkit = join(repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const read = (name: string): string => readFileSync(join(toolkit, name), 'utf8');

describe('MCP advisory state/config contract', () => {
  it('exposes exactly the three user-facing verbosity levels', () => {
    const header = read('HaybaMCPAdvisoryTypes.h');
    const body = header.match(/enum class EHaybaMCPAdvisoryVerbosity[^\{]*\{([^}]*)\}/s)?.[1] ?? '';
    const names = [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:UMETA|,)/gm)].map((m) => m[1]);
    expect(names).toEqual(['ErrorsOnly', 'ErrorsAndWarnings', 'ErrorsWarningsAndTips']);
    const settings = read('HaybaMCPDeveloperSettings.h');
    expect(settings).toContain('EHaybaMCPAdvisoryVerbosity AdvisoryVerbosity');
    expect(settings).toContain('EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings');
  });

  it('keeps all nine lifecycle states and a single response-boundary seam', () => {
    const header = read('HaybaMCPAdvisory.h');
    for (const state of [
      'Success',
      'SuccessNeedsVerification',
      'PartialSuccess',
      'InputRejected',
      'PolicyBlocked',
      'RetryableFailure',
      'UnknownOutcome',
      'SessionSuspect',
      'FatalError',
    ]) {
      expect(header).toMatch(new RegExp(`\\b${state}\\b`));
    }
    expect(header).toContain('void ApplyToResponse(');
    expect(header).toContain('EHaybaMCPAdvisoryVerbosity Verbosity');
    for (const field of ['Severity', 'Code', 'MutationStatus', 'SessionHealth', 'NextAction']) {
      expect(header).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('has executable C++ coverage for every state and all verbosity levels', () => {
    const test = read(join('Tests', 'HaybaMCPAdvisoryTest.cpp'));
    for (const state of [
      'Success',
      'SuccessNeedsVerification',
      'PartialSuccess',
      'InputRejected',
      'PolicyBlocked',
      'RetryableFailure',
      'UnknownOutcome',
      'SessionSuspect',
      'FatalError',
    ]) {
      expect(test).toContain(`EHaybaMCPAdvisoryState::${state}`);
    }
    expect(test).toContain('EHaybaMCPAdvisoryVerbosity::ErrorsOnly');
    expect(test).toContain('EHaybaMCPAdvisoryVerbosity::ErrorsAndWarnings');
    expect(test).toContain('EHaybaMCPAdvisoryVerbosity::ErrorsWarningsAndTips');
    expect(test).toContain('preserves legacy mandatory recovery');
    for (const transition of ['timeout after execute', 'save failure', 'crash guard', 'SEH']) {
      expect(test).toContain(transition);
    }
  });

  it('classifies untrimmed facts and never drops correctness fields', () => {
    const command = read('HaybaMCPCommandHandler.cpp');
    const postDispatch = command.slice(
      command.indexOf('const int64 DurMs'),
      command.indexOf('FString FHaybaMCPCommandHandler::MakeOkResponse'),
    );
    const classifyAt = postDispatch.indexOf('SignalsForSuccess(Cmd, DataObj)');
    expect(classifyAt).toBeGreaterThanOrEqual(0);
    for (const successDependentBoundary of [
      'if (bEffectiveOk) GEditor->EndTransaction()',
      'ParamsHash, DurMs, bEffectiveOk, EffectiveError',
      'if (bEffectiveOk && Result.Data.IsValid())',
      'PushDiffEntries(Cmd, Params, BeforeState)',
      'M->RecordToolCall(Cmd, ParamsStr, ResultStr)',
      'Builder.Build(DataObj.ToSharedRef())',
    ]) {
      expect(classifyAt).toBeLessThan(postDispatch.indexOf(successDependentBoundary));
    }
    expect(postDispatch).toContain('const bool bEffectiveOk = Result.bOk && SuccessSignals.bOperationSucceeded');
    expect(postDispatch).toContain('StreamError->SetObjectField(TEXT("data")');

    const responseLimits = read('HaybaMCPResponseBuilder.h');
    for (const fact of [
      'succeeded',
      'failed',
      'saved',
      'save_verified',
      'verified',
      'readback_verified',
      'compiled_clean',
      'dirty',
      'dirty_count',
    ]) {
      expect(responseLimits).toContain(`TEXT("${fact}")`);
    }
    expect(read(join('Tests', 'HaybaResponseBuilderTest.cpp'))).toContain('save fact survives the field cap');
  });
});
