import { describe, it, expect } from 'vitest';
import { getPreset, conventionsToIni, iniToConventions, type PresetName } from './conventions.js';

describe('getPreset', () => {
  it('returns independent copies — mutating one preset does not leak into another read', () => {
    const a = getPreset('epic-default');
    a.folders.pcgGraphs = '/Mutated';
    const b = getPreset('epic-default');
    expect(b.folders.pcgGraphs).toBe('/Game/PCG');
  });

  it.each<PresetName>(['epic-default', 'gamedevtv', 'custom'])(
    'every preset defaults autoOpenInGaeaAfterBake to false (%s)',
    (name) => {
      expect(getPreset(name).workflow.autoOpenInGaeaAfterBake).toBe(false);
    },
  );
});

describe('conventionsToIni / iniToConventions round-trip', () => {
  it('reconstructs an identical object for every preset', () => {
    for (const name of ['epic-default', 'gamedevtv', 'custom'] as PresetName[]) {
      const original = getPreset(name);
      const ini = conventionsToIni(original);
      const restored = iniToConventions(ini);
      expect(restored).toEqual(original);
    }
  });

  it('round-trips a workflow with autoOpenInGaeaAfterBake explicitly true', () => {
    const original = getPreset('epic-default');
    original.workflow.autoOpenInGaeaAfterBake = true;
    original.workflow.confirmBeforeOverwrite = false;
    const restored = iniToConventions(conventionsToIni(original));
    expect(restored.workflow.autoOpenInGaeaAfterBake).toBe(true);
    expect(restored.workflow.confirmBeforeOverwrite).toBe(false);
  });
});

describe('iniToConventions defaults on a hand-authored/partial ini', () => {
  // A human editing DefaultHayba.ini by hand, or an older ini written before a
  // field existed, will not have every key conventionsToIni() would emit.
  // Bug found while writing this test: autoOpenInGaeaAfterBake used
  // `!== 'false'`, so an ABSENT key defaulted to true — the opposite of every
  // preset's default (false) — silently turning on "auto-open in Gaea after
  // every bake" for anyone whose ini predates the flag. Fixed in conventions.ts
  // to `=== 'true'`, matching confirmBeforeOverwrite's intentional asymmetry
  // (that one legitimately defaults true when absent).
  it('defaults autoOpenInGaeaAfterBake to false when the key is entirely absent', () => {
    const ini = '[Conventions]\npreset=custom\n';
    const c = iniToConventions(ini);
    expect(c.workflow.autoOpenInGaeaAfterBake).toBe(false);
  });

  it('defaults confirmBeforeOverwrite to true when the key is entirely absent', () => {
    const ini = '[Conventions]\npreset=custom\n';
    const c = iniToConventions(ini);
    expect(c.workflow.confirmBeforeOverwrite).toBe(true);
  });

  it('honors an explicit workflow.autoOpenInGaeaAfterBake=true', () => {
    const ini = '[Conventions]\npreset=custom\nworkflow.autoOpenInGaeaAfterBake=true\n';
    expect(iniToConventions(ini).workflow.autoOpenInGaeaAfterBake).toBe(true);
  });

  it('honors an explicit workflow.confirmBeforeOverwrite=false', () => {
    const ini = '[Conventions]\npreset=custom\nworkflow.confirmBeforeOverwrite=false\n';
    expect(iniToConventions(ini).workflow.confirmBeforeOverwrite).toBe(false);
  });

  it('falls back to preset=custom and empty folders/naming when the ini is bare', () => {
    const c = iniToConventions('[Conventions]\n');
    expect(c.preset).toBe('custom');
    expect(c.folders.pcgGraphs).toBe('');
    expect(c.naming.folderCasing).toBe('PascalCase');
  });

  it('ignores comment/section lines and blank lines while parsing', () => {
    const ini = [
      '[Conventions]',
      '',
      'preset=epic-default',
      'folders.pcgGraphs=/Game/PCG',
    ].join('\n');
    const c = iniToConventions(ini);
    expect(c.preset).toBe('epic-default');
    expect(c.folders.pcgGraphs).toBe('/Game/PCG');
  });
});
