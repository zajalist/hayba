import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nativeFile = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', ...parts), 'utf8');
const commandHandler = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'HaybaMCPCommandHandler.cpp'),
  'utf8',
);

describe('native handler SEH containment', () => {
  it('hashes params before dispatch and returns before normal post-processing after a fault', () => {
    const hashAt = commandHandler.indexOf('const FString ParamsHash');
    const dispatchAt = commandHandler.indexOf('HaybaSeh::RunGuarded', hashAt);
    const crashResultAt = commandHandler.indexOf('if (bHandlerCrashed)', dispatchAt);
    // Handler-owned guards (python_run, material) count too: bNativeFault.
    const crashRecoveryAt = commandHandler.indexOf('if (bNativeFault)', crashResultAt + 1);
    const normalJournalAt = commandHandler.indexOf(
      '// Journal using result directly',
      crashRecoveryAt,
    );

    expect(hashAt).toBeGreaterThan(0);
    expect(dispatchAt).toBeGreaterThan(hashAt);
    expect(crashResultAt).toBeGreaterThan(dispatchAt);
    expect(crashRecoveryAt).toBeGreaterThan(crashResultAt);
    expect(commandHandler.slice(crashRecoveryAt, normalJournalAt)).toContain(
      'return MakeErrorResponse',
    );
  });

  it('does not claim the editor is healthy after a native fault', () => {
    expect(commandHandler).not.toContain('editor kept alive');
    expect(commandHandler).toContain('Treat the editor session as suspect');
  });

  it('poisons the session: refuses everything but ping and flags every reply', () => {
    expect(commandHandler).toContain('HaybaSeh::IsSessionPoisoned() && Cmd != TEXT("ping")');
    expect(commandHandler).toContain('Envelope.SetBoolField(TEXT("session_poisoned"), true)');
    expect(nativeFile('HaybaMCPSeh.cpp')).toContain('Stack.SetNum(Before.SlowTaskDepth');
    expect(nativeFile('handlers', 'HaybaMCPPythonHandler.cpp')).toMatch(
      /ExecPythonGuarded\([^)]*\)\s*\{[\s\S]{0,400}IsSessionPoisoned\(\)/,
    );
  });

  it('never drains a TCP command nested inside another command, slow task or modal loop', () => {
    const tcp = nativeFile('HaybaMCPTcpServer.cpp');
    const guardAt = tcp.indexOf('const bool bNestedTick');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(tcp.indexOf('CommandHandler->ProcessCommand(', guardAt));
    expect(tcp.slice(guardAt, guardAt + 400)).toContain('GIsSlowTask');
  });
});
