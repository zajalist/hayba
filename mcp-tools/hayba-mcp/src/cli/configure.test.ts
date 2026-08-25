import { describe, it, expect } from 'vitest';
import {
  CLIENT_SPECS,
  buildEntry,
  planConfigChange,
  planConfigOverwrite,
  type ClientSpec,
} from './configure.js';

const spec = (id: string): ClientSpec =>
  CLIENT_SPECS.find((s) => s.id === id) as ClientSpec;

const ENTRY = { command: 'node', args: ['C:/hayba/dist/index.js'] };

describe('client specs', () => {
  it('uses `servers` for VS Code and `mcpServers` for the rest', () => {
    // Not cosmetic. The wrong key writes a well-formed file the client
    // ignores, which is the silent failure this command exists to remove.
    expect(spec('vscode').serversKey).toBe('servers');
    expect(spec('claude-code').serversKey).toBe('mcpServers');
    expect(spec('cursor').serversKey).toBe('mcpServers');
    expect(spec('claude-desktop').serversKey).toBe('mcpServers');
  });

  it('only VS Code gets an explicit stdio type', () => {
    expect(buildEntry(spec('vscode'), ENTRY).type).toBe('stdio');
    expect(buildEntry(spec('cursor'), ENTRY).type).toBeUndefined();
  });
});

describe('planConfigChange', () => {
  it('creates the map when the file does not exist', () => {
    const plan = planConfigChange(null, spec('claude-code'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('added');
    const written = JSON.parse(plan.nextText as string);
    expect(written.mcpServers.hayba).toEqual({
      command: 'node',
      args: ['C:/hayba/dist/index.js'],
    });
  });

  it('treats an empty file as an absent one', () => {
    expect(planConfigChange('   \n', spec('cursor'), 'hayba', ENTRY).verdict).toBe('added');
  });

  it('PRESERVES other servers and unrelated top-level keys', () => {
    // The config is the user's file, not ours. Authoring a replacement from
    // our own model would silently delete whatever else lives in it.
    const current = JSON.stringify({
      mcpServers: { other: { command: 'python', args: ['x.py'] } },
      someUnrelatedSetting: { deep: [1, 2, 3] },
    });
    const plan = planConfigChange(current, spec('claude-code'), 'hayba', ENTRY);
    const written = JSON.parse(plan.nextText as string);
    expect(written.mcpServers.other).toEqual({ command: 'python', args: ['x.py'] });
    expect(written.someUnrelatedSetting).toEqual({ deep: [1, 2, 3] });
    expect(written.mcpServers.hayba).toBeDefined();
  });

  it('reports already-current instead of rewriting an identical entry', () => {
    const current = JSON.stringify({ mcpServers: { hayba: { ...ENTRY } } });
    const plan = planConfigChange(current, spec('claude-code'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('already-current');
    expect(plan.nextText).toBeUndefined();
  });

  it('compares args element-wise, not by identity', () => {
    const current = JSON.stringify({
      mcpServers: { hayba: { command: 'node', args: ['C:/hayba/dist/index.js'] } },
    });
    expect(planConfigChange(current, spec('claude-code'), 'hayba', ENTRY).verdict)
      .toBe('already-current');
  });

  it('refuses to overwrite a DIFFERENT existing entry', () => {
    // Someone pointed this name at another build on purpose. Clobbering it is
    // the kind of "help" that costs an afternoon to diagnose.
    const current = JSON.stringify({
      mcpServers: { hayba: { command: 'node', args: ['D:/other/build.js'] } },
    });
    const plan = planConfigChange(current, spec('claude-code'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('differs');
    expect(plan.nextText).toBeUndefined();
    expect(plan.existing).toEqual({ command: 'node', args: ['D:/other/build.js'] });
    expect(plan.reason).toContain('--force');
  });

  it('a differing arg COUNT is still a difference', () => {
    const current = JSON.stringify({
      mcpServers: { hayba: { command: 'node', args: ['C:/hayba/dist/index.js', '--verbose'] } },
    });
    expect(planConfigChange(current, spec('claude-code'), 'hayba', ENTRY).verdict).toBe('differs');
  });

  it('refuses to rewrite a config it cannot parse', () => {
    const plan = planConfigChange('{ "mcpServers": { /* comment */ } }', spec('cursor'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('unparsable');
    expect(plan.nextText).toBeUndefined();
    expect(plan.reason).toContain('discard');
  });

  it('refuses valid JSON that is not an object', () => {
    expect(planConfigChange('[]', spec('cursor'), 'hayba', ENTRY).verdict).toBe('unparsable');
    expect(planConfigChange('"hello"', spec('cursor'), 'hayba', ENTRY).verdict).toBe('unparsable');
  });

  it('survives the servers key holding the wrong type', () => {
    // A hand-edited config can contain anything. Replacing a non-map with a
    // map is the only sane move, and it must not throw.
    const plan = planConfigChange('{"mcpServers": "oops"}', spec('cursor'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('added');
    expect(JSON.parse(plan.nextText as string).mcpServers.hayba).toBeDefined();
  });

  it('writes VS Code entries under `servers` with a stdio type', () => {
    const plan = planConfigChange(null, spec('vscode'), 'hayba', ENTRY);
    const written = JSON.parse(plan.nextText as string);
    expect(written.mcpServers).toBeUndefined();
    expect(written.servers.hayba.type).toBe('stdio');
  });

  it('ends the file with a newline', () => {
    const plan = planConfigChange(null, spec('cursor'), 'hayba', ENTRY);
    expect(plan.nextText?.endsWith('\n')).toBe(true);
  });
});

describe('planConfigOverwrite', () => {
  it('replaces a differing entry', () => {
    const current = JSON.stringify({
      mcpServers: {
        hayba: { command: 'node', args: ['D:/other/build.js'] },
        keepme: { command: 'x', args: [] },
      },
    });
    const plan = planConfigOverwrite(current, spec('claude-code'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('added');
    const written = JSON.parse(plan.nextText as string);
    expect(written.mcpServers.hayba.args).toEqual(['C:/hayba/dist/index.js']);
    expect(written.mcpServers.keepme).toBeDefined();
  });

  it('still refuses an unparsable file — force is not a licence to destroy', () => {
    const plan = planConfigOverwrite('{oops', spec('cursor'), 'hayba', ENTRY);
    expect(plan.verdict).toBe('unparsable');
    expect(plan.nextText).toBeUndefined();
  });

  it('is a no-op when the entry already matches', () => {
    const current = JSON.stringify({ mcpServers: { hayba: { ...ENTRY } } });
    expect(planConfigOverwrite(current, spec('claude-code'), 'hayba', ENTRY).verdict)
      .toBe('already-current');
  });
});
