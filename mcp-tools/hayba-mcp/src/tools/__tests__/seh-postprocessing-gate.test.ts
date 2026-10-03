import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const privateDir = join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const commandHandler = readFileSync(join(privateDir, 'HaybaMCPCommandHandler.cpp'), 'utf8');
const pythonHandler = readFileSync(join(privateDir, 'handlers', 'HaybaMCPPythonHandler.cpp'), 'utf8');
const materialHandler = readFileSync(join(privateDir, 'handlers', 'HaybaMCPMaterialHandler.cpp'), 'utf8');

describe('native handler SEH containment', () => {
  it('hashes params before dispatch and returns before normal post-processing after a fault', () => {
    const hashAt = commandHandler.indexOf('const FString ParamsHash');
    const dispatchAt = commandHandler.search(/HaybaSeh::RunGuarded(?:At)?\(EHaybaFaultSite::Dispatch/);
    const faultAt = commandHandler.indexOf('if (bHandlerCrashed || bInnerFaultCaught)', dispatchAt);
    const normalJournalAt = commandHandler.indexOf('FHaybaJournalEntry E{', faultAt);

    expect(hashAt).toBeGreaterThan(0);
    expect(dispatchAt).toBeGreaterThan(hashAt);
    expect(faultAt).toBeGreaterThan(dispatchAt);
    expect(normalJournalAt).toBeGreaterThan(faultAt);
    expect(commandHandler.slice(faultAt, normalJournalAt)).toContain('return MakeNativeFaultContained(');
  });

  it('does not claim the editor is healthy after a native fault', () => {
    for (const [name, source] of [
      ['router', commandHandler],
      ['python', pythonHandler],
      ['material', materialHandler],
    ] as const) {
      expect(source.toLowerCase(), name).not.toContain('kept alive');
      expect(source.toLowerCase(), name).not.toContain('disposable editor');
    }
    expect(pythonHandler).toContain('Fault contained; restart the editor before further work.');
    expect(materialHandler).toContain('Fault contained; restart the editor before further work.');
  });
});
