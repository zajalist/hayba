import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, __resetSettingsCache } from './settings-watcher.js';

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
    expect(readSettings()).toEqual({ toolRouting: 'deferred', alwaysLoadPacks: [] });
  });

  it('reads valid JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'full', alwaysLoadPacks: ['biome'],
    }));
    expect(readSettings()).toEqual({ toolRouting: 'full', alwaysLoadPacks: ['biome'] });
  });

  it('falls back to defaults on malformed JSON', () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, '{not json');
    expect(readSettings()).toEqual({ toolRouting: 'deferred', alwaysLoadPacks: [] });
  });
});
