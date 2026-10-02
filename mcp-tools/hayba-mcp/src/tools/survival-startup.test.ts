import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

async function withPeer(
  respond: (socket: net.Socket, request: Record<string, unknown>) => void,
  check: (port: number) => Promise<void>,
) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data]);
      if (answered || buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      answered = true;
      respond(socket, JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString('utf8')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await check((server.address() as net.AddressInfo).port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function send(socket: net.Socket, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  socket.end(Buffer.concat([header, body]));
}

function invoke(port: number, structuredTimeout = false, timeout = 250) {
  const invoker = join(scripts, 'invoke-tcp-command.ps1').replaceAll("'", "''");
  const command = `try { & '${invoker}' -Cmd ping -Port ${port} -TimeoutMs ${timeout} ${structuredTimeout ? '-ThrowOnTimeout' : ''}; exit $LASTEXITCODE } catch [TimeoutException] { [Console]::Out.Write('structured-timeout'); exit 7 }`;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 6000, windowsHide: true }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) { reject(error); return; }
        resolve({ code: error?.code as number ?? 0, stdout, stderr });
      });
  });
}

describe('survival startup readiness', () => {
  it('validates fresh identity with one process query and refuses changed or missing proof', () => {
    const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      join(scripts, 'test-survival-startup.ps1'), '-HarnessPath',
      join(scripts, 'test-editor-survival.ps1'), '-IdentityOnly'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (run.error) throw run.error;
    expect(run.stderr).toBe('');
    const results = JSON.parse(run.stdout) as Array<{ name: string; passed: boolean; query_count: number; reason: string }>;
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results.map((result) => result.name)).toEqual([
      'valid', 'creation_changed', 'pid_changed', 'wrong_executable',
      'session_missing', 'session_deceptive', 'project_missing', 'project_deceptive',
      'command_line_changed', 'baseline_executable_changed', 'baseline_session_changed',
      'baseline_project_changed', 'missing_process', 'query_error', 'uncaptured',
    ]);
    for (const result of results) {
      expect(result.query_count).toBe(result.name === 'uncaptured' ? 0 : 1);
      expect(result.reason).toBe('');
    }
    expect(run.status).toBe(0);
  });

  it('bounds owned readiness with one budget and retains short hostile deadlines', () => {
    const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      join(scripts, 'test-survival-startup.ps1'), '-HarnessPath',
      join(scripts, 'test-editor-survival.ps1')], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (run.error) throw run.error;
    expect(run.stderr).toBe('');
    const results = JSON.parse(run.stdout) as Array<{ name: string; passed: boolean }>;
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results).toHaveLength(16);
    expect(run.status).toBe(0);
  });

  it('exposes only an opted-in transport deadline as a structured timeout', async () => {
    await withPeer(() => {}, async (port) => {
      const result = await invoke(port, true);
      expect(result).toEqual({ code: 7, stdout: 'structured-timeout', stderr: '' });
    });
  }, 10_000);

  it('preserves default timeout failure and hashed diagnostics', async () => {
    await withPeer(() => {}, async (port) => {
      const result = await invoke(port);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toMatch(/^invoke-tcp-command failed: sanitized diagnostic sha256=[a-f0-9]{64}$/);
    });
  }, 10_000);

  it('does not classify a wrong request ID as a retryable timeout', async () => {
    await withPeer((socket) => send(socket, { id: 'wrong', ok: true }), async (port) => {
      const result = await invoke(port, true, 2000);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toMatch(/^invoke-tcp-command failed: sanitized diagnostic sha256=[a-f0-9]{64}$/);
    });
  }, 10_000);

  it('returns delayed correlated replies and uses a fresh ID on every connection', async () => {
    const ids: unknown[] = [];
    await withPeer((socket, request) => {
      ids.push(request.id);
      setTimeout(() => send(socket, { id: request.id, ok: true }), 150);
    }, async (port) => {
      for (let i = 0; i < 2; i++) {
        const result = await invoke(port, true, 2000);
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({ id: ids[i], ok: true });
      }
    });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  }, 15_000);
});
