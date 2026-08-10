import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
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
    const crashRecoveryAt = commandHandler.indexOf('if (bHandlerCrashed)', crashResultAt + 1);
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
});
