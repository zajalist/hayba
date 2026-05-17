import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockWatch = vi.fn(() => ({ close: vi.fn() }));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  watch: mockWatch,
}));

let mod: typeof import('../../src/tools/disabled-tools-watcher.js');

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.HAYBA_DISABLED_TOOLS_PATH = '/tmp/hayba-test-disabled.json';
  mod = await import('../../src/tools/disabled-tools-watcher.js');
  mod.__resetDisabledToolsCache();
});

afterEach(() => {
  delete process.env.HAYBA_DISABLED_TOOLS_PATH;
});

describe('disabled-tools-watcher', () => {
  it('reports tool as not disabled when file is missing', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(mod.isToolDisabled('actor_spawn')).toBe(false);
  });

  it('reports tool as disabled when listed in file', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ disabled: ['actor_spawn', 'scene_validate_physics'] }));
    expect(mod.isToolDisabled('actor_spawn')).toBe(true);
    expect(mod.isToolDisabled('scene_validate_physics')).toBe(true);
    expect(mod.isToolDisabled('actor_list')).toBe(false);
  });

  it('returns sorted names from listDisabledTools', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ disabled: ['z_tool', 'a_tool', 'm_tool'] }));
    const list = mod.listDisabledTools();
    expect(list).toEqual(['a_tool', 'm_tool', 'z_tool']);
  });

  it('treats malformed JSON as nothing disabled', async () => {
    mockReadFileSync.mockReturnValue('{invalid json');
    expect(mod.isToolDisabled('actor_spawn')).toBe(false);
  });

  it('handles empty disabled array', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ disabled: [] }));
    expect(mod.isToolDisabled('anything')).toBe(false);
    expect(mod.listDisabledTools()).toEqual([]);
  });
});
