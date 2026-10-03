import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const expectedVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe.each(['src', 'dist'])('%s product version', (directory) => {
  it('resolves its own package from an unrelated cwd and caches the value', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hayba-version-'));
    try {
      const moduleUrl = new URL(`../${directory}/version.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url).href;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        const { HAYBA_VERSION } = await import(${JSON.stringify(moduleUrl)});
        const metadata = createRequire(${JSON.stringify(moduleUrl)})('../package.json');
        metadata.version = 'changed-after-import';
        const again = await import(${JSON.stringify(moduleUrl)});
        console.log(JSON.stringify([HAYBA_VERSION, again.HAYBA_VERSION]));
      `], { cwd, encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual([expectedVersion, expectedVersion]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('supplies package version to MCP serverInfo and the startup diagnostic', async () => {
    const serverInfo = vi.fn();
    const connected = vi.fn().mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        constructor(info: unknown) { serverInfo(info); }
        resource() {}
        connect = connected;
      },
      ResourceTemplate: class {},
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
    const mock = (relative: string, exports: object) => {
      vi.doMock(fileURLToPath(new URL(`../${directory}/${relative}`, import.meta.url)), () => exports);
    };
    mock('config.js', { config: { dashboardPort: 0, ueTcpHost: 'unused', ueTcpPort: 0 } });
    mock('resources.js', { listCatalogResources: vi.fn(), readCatalogResource: vi.fn() });
    mock('tools/index.js', { registerTools: vi.fn().mockResolvedValue({ slivers: {} }) });
    mock('dashboard/server.js', { startDashboard: vi.fn().mockResolvedValue(undefined) });
    mock('http/server.js', { startHttpServer: vi.fn() });
    mock('tools/visual/sidecar-client.js', {
      pingSidecar: vi.fn().mockResolvedValue({ available: false, url: 'mock', error: 'mock' }),
    });
    mock('security/secret-redaction.js', { installConsoleSecretRedaction: vi.fn() });

    await import(new URL(`../${directory}/index.${directory === 'src' ? 'ts' : 'js'}`, import.meta.url).href);
    await vi.waitFor(() => {
      expect(connected).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(`Hayba MCP Toolkit v${expectedVersion} started on stdio`);
    });
    expect(serverInfo).toHaveBeenCalledExactlyOnceWith({ name: 'hayba-mcp', version: expectedVersion });
  });
});
