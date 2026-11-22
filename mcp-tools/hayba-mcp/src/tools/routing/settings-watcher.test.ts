import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, __resetSettingsCache } from './settings-watcher.js';

const DEFAULTS = { toolRouting: 'deferred', alwaysLoadPacks: [], externalRouteAdvice: 'off', chatMaxSteps: 60 };

describe('settings-watcher', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-settings-'));
    process.env.HAYBA_SETTINGS_PATH = join(dir, 'settings.json');
    __resetSettingsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAYBA_SETTINGS_PATH;
  });

  it('returns defaults when file is missing', () => {
    expect(readSettings()).toEqual(DEFAULTS);
  });

  it('reads valid JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'full', alwaysLoadPacks: ['biome'], externalRouteAdvice: 'brain', chatMaxSteps: 120,
    }));
    expect(readSettings()).toEqual({ toolRouting: 'full', alwaysLoadPacks: ['biome'], externalRouteAdvice: 'brain', chatMaxSteps: 120 });
  });

  it('caps chatMaxSteps and ignores invalid values', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({ chatMaxSteps: 9999 }));
    expect(readSettings().chatMaxSteps).toBe(500);
    __resetSettingsCache();
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({ chatMaxSteps: 0 }));
    expect(readSettings().chatMaxSteps).toBe(60);
  });

  it('falls back to defaults on malformed JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, '{not json');
    expect(readSettings()).toEqual(DEFAULTS);
  });
});
