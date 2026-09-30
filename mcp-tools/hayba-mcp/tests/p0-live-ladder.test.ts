import { describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Conn, once, findScratchPort, runSteps, exitCodeFor, check, parseArgs, STEPS,
} from '../scripts/p0-live-ladder.mjs';

type Envelope = { cmd: string; id: string; params: Record<string, unknown>; owner?: string; lease?: string };

async function fakeEditor(answer: (env: Envelope) => Record<string, unknown> | null) {
  const seen: Envelope[] = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    connections += 1;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const env = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as Envelope;
        buf = buf.subarray(4 + len);
        seen.push(env);
        const reply = answer(env);
        if (!reply) continue;
        const body = Buffer.from(JSON.stringify({ id: env.id, ...reply }), 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length, 0);
        sock.write(Buffer.concat([head, body]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    connections: () => connections,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

function scratchTree(port: number, under = 'UEScratch') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
  const hostDir = path.join(root, under, 'h58');
  const instances = path.join(hostDir, 'Saved', 'HaybaMCP', 'instances');
  fs.mkdirSync(instances, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'h58.uproject'), '{}');
  fs.writeFileSync(path.join(instances, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, port, project_dir: hostDir, started_at: new Date().toISOString() }));
  return hostDir;
}

describe('p0-live-ladder transport', () => {
  it('sends owner and lease on the envelope and correlates replies by id', async () => {
    const ed = await fakeEditor((env) => ({ ok: true, data: { echo: env.cmd } }));
    const c = await new Conn(ed.port, { owner: 'ladder-x', lease: 'ls_2_abc' }).open();
    try {
      const [a, b] = await Promise.all([c.send('ping'), c.send('lease_status', {}, { owner: 'ladder-y', lease: null })]);
      expect(a.data.echo).toBe('ping');
      expect(b.data.echo).toBe('lease_status');
      expect(ed.seen[0]).toMatchObject({ cmd: 'ping', owner: 'ladder-x', lease: 'ls_2_abc' });
      expect(ed.seen[1]).toMatchObject({ cmd: 'lease_status', owner: 'ladder-y' });
      expect(ed.seen[1]).not.toHaveProperty('lease');
    } finally {
      c.close();
      await ed.close();
    }
  });

  it('once() opens and closes one connection per call (the per-call pass, R-9)', async () => {
    const ed = await fakeEditor(() => ({ ok: true, data: {} }));
    try {
      await once(ed.port, 'ping');
      await once(ed.port, 'ping');
      expect(ed.connections()).toBe(2);
    } finally {
      await ed.close();
    }
  });

  it('a send with no reply times out and says a modal would do this', async () => {
    const ed = await fakeEditor(() => null);
    const c = await new Conn(ed.port).open();
    try {
      await expect(c.send('level_save', {}, { timeoutMs: 200 })).rejects.toThrow(/no reply .* modal/);
    } finally {
      c.close();
      await ed.close();
    }
  });
});

describe('p0-live-ladder scratch-host guard (R-5)', () => {
  it('returns the live heartbeat port of a scratch host', () => {
    expect(findScratchPort(scratchTree(52343))).toBe(52343);
  });
  it('refuses a directory outside UEScratch', () => {
    expect(() => findScratchPort(scratchTree(52343, 'Projects'))).toThrow(/UEScratch/);
  });
  it('refuses a scratch host that holds 52342', () => {
    expect(() => findScratchPort(scratchTree(52342))).toThrow(/52342/);
  });
  it('refuses when no editor is alive', () => {
    expect(() => findScratchPort(scratchTree(52343), () => false)).toThrow(/found 0/);
  });
});

describe('p0-live-ladder runner', () => {
  it('reports FAIL, SKIP-MANUAL and PASS and picks the exit code', async () => {
    const steps = [
      { id: 'X1', title: 'fails', run: async () => check(false, 'boom') },
      { id: 'X2', title: 'needs a person', manual: true, run: async () => {} },
      { id: 'X3', title: 'passes', run: async () => {} },
    ];
    const results = await runSteps(steps, {}, {});
    expect(results.map((r: { status: string }) => r.status)).toEqual(['FAIL', 'SKIP-MANUAL', 'PASS']);
    expect(results[0].error).toBe('boom');
    expect(exitCodeFor(results)).toBe(1);
    expect(exitCodeFor(results.slice(1))).toBe(3);
    expect(exitCodeFor(results.slice(2))).toBe(0);
  });
  it('--only selects steps and --manual runs manual ones', async () => {
    const ran: string[] = [];
    const steps = ['Y1', 'Y2'].map((id) => ({ id, title: id, manual: id === 'Y2', run: async () => { ran.push(id); } }));
    await runSteps(steps, {}, { only: ['Y2'], manual: true });
    expect(ran).toEqual(['Y2']);
  });
  it('parseArgs requires --deploy and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--deploy/);
    expect(() => parseArgs(['--deploy', 'a', '--frobnicate'])).toThrow(/unknown argument/);
    expect(parseArgs(['--deploy', 'A', '--only', 'A1,A2', '--manual'])).toMatchObject({ deploy: 'a', only: ['A1', 'A2'], manual: true });
  });
  it('the Deploy A ladder is A1-A8, with the Play and restart steps manual', () => {
    expect(STEPS.a.map((s: { id: string }) => s.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A7b', 'A8']);
    expect(STEPS.a.filter((s: { manual?: boolean }) => s.manual).map((s: { id: string }) => s.id)).toEqual(['A3', 'A7b', 'A8']);
  });
});
