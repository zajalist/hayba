import { afterEach, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.skipIf(process.platform !== 'win32')('installs a copied plugin sidecar idempotently and refuses to overwrite another install', () => {
  const root = mkdtempSync(join(tmpdir(), 'hayba-chat-install-'));
  roots.push(root);
  mkdirSync(join(root, 'tools'));
  const script = join(root, 'tools/link-chat-sidecar.ps1');
  copyFileSync(resolve('../../tools/link-chat-sidecar.ps1'), script);
  const pkg = join(root, 'mcp-tools/hayba-mcp');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  const project = join(root, 'Game with spaces');
  const plugin = join(project, 'Plugins/HaybaMCPToolkit');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(project, 'Game.uproject'), '{}');
  writeFileSync(join(plugin, 'HaybaMCPToolkit.uplugin'), '{}');
  const run = () => spawnSync('pwsh', ['-NoProfile', '-File', script, '-Project', join(project, 'Game.uproject')], { encoding: 'utf8' });
  const missing = run();
  expect(missing.status, missing.stderr).not.toBe(0);
  expect(existsSync(join(plugin, 'ThirdParty/mcp_server'))).toBe(false);
  writeFileSync(join(pkg, 'dist/index.js'), '// built server');
  for (let i = 0; i < 2; i++) {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(plugin, 'ThirdParty/mcp_server/dist/index.js'), 'utf8')).toBe('// built server');
  }
  rmSync(join(plugin, 'ThirdParty/mcp_server'), { recursive: true });
  mkdirSync(join(plugin, 'ThirdParty/mcp_server'));
  writeFileSync(join(plugin, 'ThirdParty/mcp_server/keep.txt'), 'existing install');
  expect(run().status).not.toBe(0);
  expect(readFileSync(join(plugin, 'ThirdParty/mcp_server/keep.txt'), 'utf8')).toBe('existing install');
}, 20_000);
