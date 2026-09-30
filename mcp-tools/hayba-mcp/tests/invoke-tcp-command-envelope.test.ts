import { describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'invoke-tcp-command.ps1');

async function hasPwsh(): Promise<boolean> {
  try {
    await run('pwsh', ['-NoProfile', '-Command', 'exit 0']);
    return true;
  } catch {
    return false;
  }
}
const pwshAvailable = await hasPwsh();

/** Answers exactly one framed request, then records the envelope it got. */
function oneShotEditor() {
  const seen: Array<Record<string, unknown>> = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const env = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as Record<string, unknown>;
      seen.push(env);
      const body = Buffer.from(JSON.stringify({ id: env.id, ok: true, data: {} }), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      sock.end(Buffer.concat([head, body]));
    });
  });
  return new Promise<{ port: number; seen: Array<Record<string, unknown>>; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() }),
    ),
  );
}

describe('invoke-tcp-command.ps1 envelope fields', () => {
  it.runIf(pwshAvailable)('sends -Owner and -Lease as top-level envelope fields', async () => {
    const ed = await oneShotEditor();
    try {
      await run('pwsh', ['-NoProfile', '-File', SCRIPT, '-Cmd', 'ping', '-Port', String(ed.port),
        '-Owner', 'ladder-x', '-Lease', 'ls_1_abcdef012345']);
      expect(ed.seen).toHaveLength(1);
      expect(ed.seen[0]).toMatchObject({ cmd: 'ping', owner: 'ladder-x', lease: 'ls_1_abcdef012345' });
      expect(ed.seen[0]!.params).toEqual({});
    } finally {
      ed.close();
    }
  }, 30_000);

  it.runIf(pwshAvailable)('omits owner and lease when the switches are not given', async () => {
    const ed = await oneShotEditor();
    try {
      await run('pwsh', ['-NoProfile', '-File', SCRIPT, '-Cmd', 'ping', '-Port', String(ed.port)]);
      expect(ed.seen[0]).not.toHaveProperty('owner');
      expect(ed.seen[0]).not.toHaveProperty('lease');
    } finally {
      ed.close();
    }
  }, 30_000);
});
