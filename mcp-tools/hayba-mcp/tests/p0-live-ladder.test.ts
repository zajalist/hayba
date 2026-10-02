import { describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Conn, once, findScratchPort, runSteps, exitCodeFor, check, parseArgs, STEPS,
} from '../scripts/p0-live-ladder.mjs';

type Envelope = { cmd: string; id: string; params: Record<string, unknown>; owner?: string; lease?: string };

async function fakeEditor(answer: (env: Envelope, conn: number) => Record<string, unknown> | null,
  onClose?: (conn: number) => void) {
  const seen: Envelope[] = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    connections += 1;
    const conn = connections;
    sockets.add(sock);
    sock.on('close', () => { sockets.delete(sock); onClose?.(conn); });
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const env = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as Envelope;
        buf = buf.subarray(4 + len);
        seen.push(env);
        const reply = answer(env, conn);
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

// Native-shaped fixtures: LeaseHandler, BatchHandler, LevelHandler and SaveVerify.
// The deterministic B suite never opens a socket or waits on wall-clock time.
type Reply = Record<string, any>;
type Call = { cmd: string; params: Reply; opts: Reply };
const success = (data: Reply = {}) => ({ ok: true, data });
const grant = (owner: string, extra: Reply = {}) => success({ status: 'granted', owner, lease_id: 'ls_2_fixture', ...extra });
const release = () => success({ released: true, lease_id: 'ls_2_fixture' });
function bStep(id: string) {
  const step = STEPS.b.find((s: { id: string }) => s.id === id);
  expect(step, `${id} must be implemented`).toBeDefined();
  return step;
}
function bContext(answer: (c: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  let clock = 0;
  const ctx: any = {
    calls, retainedFixtures: [],
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    logTail: () => ({ read: () => '', lines: () => [] }),
    call: async (cmd: string, params: Reply = {}, opts: Reply = {}) => {
      const c = { cmd, params, opts }; calls.push(c); return answer(c);
    },
  };
  return ctx;
}
function refusal(owner: string, caller = 'conn:1', code = 'owner_required', reason = 'owner_missing', repeats = 1) {
  return { ok: false, code, lease: { code, enforcement: 'enforced_for_writes', reason,
    command: 'material_set_param', access_class: 'write_scoped', caller_owner: caller,
    holder_owner: owner, other_owners: [owner], repeats_in_window: repeats } };
}
function fileContext(kind: 'asset' | 'map', change?: (c: Call, r: Reply) => Reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-b-fixture-'));
  let pkg = ''; let dirty = false;
  const ctx = bContext(({ cmd, params, opts }) => {
    let r: Reply;
    if (cmd === 'blueprint_create' || cmd === 'level_create') {
      pkg = params.package_path ?? params.path;
      fs.writeFileSync(ctx.contentFile(pkg, kind === 'asset' ? '.uasset' : '.umap'), 'fixture');
      ctx.createdMode = fs.statSync(ctx.contentFile(pkg, kind === 'asset' ? '.uasset' : '.umap')).mode & 0o777;
      r = kind === 'asset' ? success({ path: `${pkg}.${params.name}`, saved: true, dirty: false })
        : success({ path: pkg, observed_path: pkg, created: true, saved: true, verified: true, dirty: false });
    } else if (cmd === 'blueprint_compile') {
      r = params.save ? { ok: false, code: 'package_read_only', data: { code: 'package_read_only',
        make_writable_hint: 'Make writable or use save:false', read_only_files: [ctx.contentFile(pkg, '.uasset')] } }
        : success({ ok: true, compiled: true, save_requested: false });
    } else if (cmd === 'python_run') {
      if (params.script.includes('spawn_actor_from_class')) dirty = true;
      if (params.script.includes('HAYBA_DELETE_RESULT')) {
        ctx.onDelete?.();
        fs.unlinkSync(ctx.contentFile(pkg, '.uasset')); r = success({ ok: true, stdout: 'HAYBA_DELETE_RESULT True\n', stderr: '' });
      } else if (params.script.includes('SAVE_RESULT')) {
        r = success({ ok: true, stdout: 'SAVE_RESULT False\n', stderr: '' });
      } else {
        r = success({ ok: true, stdout: `HAYBA_MAP_STATE ${JSON.stringify({ path: pkg, dirty })}\n`, stderr: '' });
      }
    } else if (cmd === 'level_get_info') r = success({ package_path: pkg });
    else if (cmd === 'level_save') {
      if ((fs.statSync(ctx.contentFile(pkg, '.umap')).mode & 0o200) === 0) {
        r = { ok: false, code: 'package_read_only', data: { code: 'package_read_only', make_writable_hint: 'Make writable', read_only_files: [ctx.contentFile(pkg, '.umap')] } };
      } else { dirty = false; r = success({ saved: true, verified: true, dirty: false }); }
    } else throw new Error(`unexpected fixture command ${cmd}`);
    return change ? change({ cmd, params, opts }, r) : r;
  });
  ctx.contentFile = (_pkg: string, ext: string) => path.join(dir, `fixture${ext}`);
  ctx.file = () => ctx.contentFile(pkg, kind === 'asset' ? '.uasset' : '.umap');
  ctx.dispose = () => { for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o666); fs.rmSync(dir, { recursive: true }); };
  return ctx;
}

describe('Deploy B deterministic behavior', () => {
  it('keeps B1-B10 and only B7/B8 manual', () => {
    expect(STEPS.b.map((s: { id: string }) => s.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
    expect(STEPS.b.filter((s: { manual?: boolean }) => s.manual).map((s: { id: string }) => s.id)).toEqual(['B7', 'B8']);
  });
  it.each([false, true])('B1 rejects failed ping or advisory mode (%s)', async (ok) => {
    await expect(bStep('B1').run(bContext(() => ({ ok, data: { capabilities: { lease_id: true, lease_enforcement: 'advisory', owner_required: true } } })))).rejects.toThrow();
  });
  it.each(['valid', 'boolean-renew', 'queued', 'output-token', 'pending-ping', 'bad-release', 'failed-status'])('B2 validates native renew, executed ping and checked cleanup: %s', async (variant) => {
    let owner = ''; let closed = false;
    const ctx = bContext(({ cmd, params }) => {
      if (cmd === 'lease_acquire') return variant === 'queued' ? success({ owner, status: 'queued', ticket: 'lt_fixture' })
        : grant(owner, variant === 'output-token' ? { token: 'forbidden' } : {});
      if (cmd === 'lease_renew') return params.lease_id ? success({ lease_id: params.lease_id, renewed: true }) : success({ owner, renewed: variant === 'boolean-renew' ? true : 1, leases: [{ lease_id: 'ls_2_fixture' }] });
      if (cmd === 'editor_batch') return success({ job_id: 'batch_fixture', steps_total: 1 });
      if (cmd === 'batch_status') return { ok: variant !== 'failed-status', data: { job_id: 'batch_fixture', owner, status: 'succeeded', steps_total: 1, steps_run: 1,
        steps: [{ index: 0, cmd: 'ping', state: variant === 'pending-ping' ? 'pending' : 'ok', data: { capabilities: { lease_id: true } } }] } };
      if (cmd === 'lease_release') return variant === 'bad-release' ? success({ released: false })
        : params.ticket ? success({ ticket: params.ticket, released: true }) : release();
      throw new Error(cmd);
    });
    ctx.conn = async (opts: Reply) => { owner = opts.owner; return { send: ctx.call, close: () => { closed = true; } }; };
    if (variant === 'valid') await bStep('B2').run(ctx);
    else await expect(bStep('B2').run(ctx)).rejects.toThrow();
    expect(closed).toBe(true);
    expect(ctx.calls.some((c: Call) => c.cmd === 'lease_release')).toBe(true);
  });
  it.each(['valid', 'unsaved', 'fake-refusal', 'bad-compile'])('B3 verifies disk persistence and safely deletes its asset: %s', async (variant) => {
    const ctx = fileContext('asset', ({ cmd }, r) => {
      if (variant === 'unsaved' && cmd === 'blueprint_create') return success({ ...r.data, saved: false });
      if (variant === 'fake-refusal' && cmd === 'blueprint_compile' && r.code) return { ...r, ok: true };
      if (variant === 'bad-compile' && cmd === 'blueprint_compile' && !r.code) return success({ compiled: false, save_requested: false });
      return r;
    });
    try {
      if (variant === 'valid') await bStep('B3').run(ctx);
      else await expect(bStep('B3').run(ctx)).rejects.toThrow();
      expect(fs.existsSync(ctx.file())).toBe(false);
    } finally { ctx.dispose(); }
  });
  it.each(['B4', 'B5'])('%s independently creates, dirties, restores and retains a saved clean map', async (id) => {
    const ctx = fileContext('map');
    try {
      await bStep(id).run(ctx);
      expect(ctx.calls[0].cmd).toBe('level_create');
      expect(ctx.calls.some((c: Call) => c.cmd === 'level_save')).toBe(true);
      expect(fs.statSync(ctx.file()).mode & 0o200).toBe(0o200);
      expect(ctx.retainedFixtures).toHaveLength(1);
      expect(ctx.calls.some((c: Call) => /delete_asset/.test(c.params.script ?? ''))).toBe(false);
    } finally { ctx.dispose(); }
  });
  it.each(['error-marker', 'wrong-map', 'clean-map', 'cleanup-failure'])('B4/B5 cannot pass false output or stale targets and report cleanup: %s', async (variant) => {
    const id = variant === 'error-marker' ? 'B4' : 'B5';
    const ctx = fileContext('map', ({ cmd, params }, r) => {
      if (variant === 'error-marker' && cmd === 'python_run' && params.script.includes('SAVE_RESULT')) return { ok: false, error: 'SAVE_RESULT False', data: { stdout: '', stderr: 'error' } };
      if (cmd === 'python_run' && params.script.includes('HAYBA_MAP_STATE')) {
        if (variant === 'wrong-map') return success({ ok: true, stdout: 'HAYBA_MAP_STATE {"path":"/Game/Wrong","dirty":true}\n', stderr: '' });
        if (variant === 'clean-map') return success({ ok: true, stdout: `HAYBA_MAP_STATE ${JSON.stringify({ path: ctx.calls[0].params.path, dirty: false })}\n`, stderr: '' });
      }
      if (variant === 'cleanup-failure' && cmd === 'level_save' && r.ok) return success({ saved: false, verified: false });
      return r;
    });
    try {
      await expect(bStep(id).run(ctx)).rejects.toThrow(variant === 'cleanup-failure' ? /cleanup/ : /./);
      expect(fs.statSync(ctx.file()).mode & 0o200).toBe(0o200);
    } finally { ctx.dispose(); }
  });
  it.each(['valid', 'not-orphaned', 'not-rebound', 'failed-release', 'reconnect-failure'])('B6 direct TCP lifecycle closes both connections on every path: %s', async (variant) => {
    let connections = 0; let renewed = false;
    const sockets: any[] = [];
    const ctx = bContext(({ cmd }) => {
      if (cmd === 'lease_acquire') return grant(ctx.owner, { bound_to_connection: true });
      if (cmd === 'lease_status') return success({ leases: [{ lease_id: 'ls_2_fixture', orphaned: renewed ? false : variant !== 'not-orphaned', bound_to_connection: renewed ? variant !== 'not-rebound' : connections === 1 }] });
      if (cmd === 'lease_renew') { renewed = true; return success({ owner: ctx.owner, renewed: 1 }); }
      if (cmd === 'lease_release') return variant === 'failed-release' ? success({ released: false }) : release();
      throw new Error(cmd);
    });
    ctx.conn = async ({ owner }: Reply) => {
      ctx.owner = owner; connections++;
      if (variant === 'reconnect-failure' && connections === 2) throw new Error('reconnect failed');
      const c = { closed: false, send: ctx.call, close: () => { c.closed = true; } }; sockets.push(c); return c;
    };
    ctx.sleep = async () => { sockets[0].closed = true; };
    if (variant === 'valid') await bStep('B6').run(ctx); else await expect(bStep('B6').run(ctx)).rejects.toThrow();
    expect(sockets.every((s) => s.closed)).toBe(true);
  });
  it.each(['valid', 'nested', 'wrong-access', 'wrong-holder', 'ok-true', 'bad-release'])('B9 requires root native refusal details: %s', async (variant) => {
    let owner = '';
    const ctx = bContext(({ cmd, opts }) => {
      if (cmd === 'lease_acquire') { owner = opts.owner; return grant(owner); }
      if (cmd === 'lease_release') return variant === 'bad-release' ? success({ released: false }) : release();
      const r = opts.owner ? refusal(owner, opts.owner, 'lease_conflict', 'held') : refusal(owner);
      if (variant === 'nested') return { ok: false, code: r.code, data: { lease: r.lease } };
      if (variant === 'wrong-access') r.lease.access_class = 'write_global';
      if (variant === 'wrong-holder') r.lease.holder_owner = 'wrong';
      if (variant === 'ok-true') r.ok = true;
      return r;
    });
    if (variant === 'valid') await bStep('B9').run(ctx); else await expect(bStep('B9').run(ctx)).rejects.toThrow();
    expect(ctx.calls.at(-1).cmd).toBe('lease_release');
  });
  it.each(['valid', 'delayed-first', 'missing-first', 'duplicate-first', 'wrong-repeats', 'duplicate-caller', 'missing-drain', 'wrong-drain', 'slow-burst'])('B10 enforces fifty fresh raw refusals and isolated ticker drain: %s', async (variant) => {
    let owner = ''; let count = 0; let time = 0;
    const ctx = bContext(({ cmd, opts }) => {
      if (cmd === 'lease_acquire') { owner = opts.owner; return grant(owner); }
      if (cmd === 'lease_release') return release();
      count++; time += variant === 'slow-burst' ? 700 : 1;
      return { id: `response_${count}`, ...refusal(owner, variant === 'duplicate-caller' ? 'conn:1' : `conn:${count}`, 'owner_required', 'owner_missing', variant === 'wrong-repeats' ? count - 1 : count) };
    });
    ctx.now = () => time;
    ctx.sleep = async (ms: number) => { time += ms; };
    ctx.logTail = () => ({ read: () => {
      const unrelated = "Warning: [enforced_for_writes] owner_required/owner_missing repeated 49 more times in 30 s: owner='conn:*' cmd='material_set_param' holder='unrelated-b9'\n";
      const first = `Warning: [enforced_for_writes] owner_required: 'material_set_param' (write_scoped) names no owner while 1 other agents are connected (${owner}).\n`;
      const drain = `Warning: [enforced_for_writes] owner_required/owner_missing repeated ${variant === 'wrong-drain' ? 48 : 49} more times in 30 s: owner='conn:*' cmd='material_set_param' holder='${owner}' conflict='global'\n`;
      const visibleFirst = variant === 'missing-first' || (variant === 'delayed-first' && time < 5_000) ? ''
        : first.repeat(variant === 'duplicate-first' ? 2 : 1);
      return unrelated + visibleFirst + (time >= 30_000 && variant !== 'missing-drain' ? drain : '');
    } });
    if (variant === 'valid' || variant === 'delayed-first') {
      await bStep('B10').run(ctx);
      const writes = ctx.calls.filter((c: Call) => c.cmd === 'material_set_param');
      expect(writes).toHaveLength(50);
      expect(new Set(writes.map((c: Call) => JSON.stringify(c.params))).size).toBe(1);
      expect(writes.every((c: Call) => !c.opts.owner && !c.opts.lease)).toBe(true);
    } else await expect(bStep('B10').run(ctx)).rejects.toThrow();
    expect(ctx.calls.at(-1).cmd).toBe('lease_release');
  });
  it('B7 failure after advisory gives an explicit restoration instruction', async () => {
    const ctx = bContext(() => success({ capabilities: { lease_enforcement: 'advisory' } }));
    let prompts = 0; ctx.human = async () => { prompts++; if (prompts > 1) throw new Error('person failed'); };
    await expect(bStep('B7').run(ctx)).rejects.toThrow(/restore.*Enforced For Writes/i);
  });
  it.each([true, false])('B8 observes mode-zero user PIE before asking Stop (%s)', async (starts) => {
    let mode = 1; let pie = 'none'; let owner = ''; let label = ''; const prompts: string[] = [];
    const ctx = bContext(({ cmd, params, opts }) => {
      if (cmd === 'lease_acquire') { owner = opts.owner; label = params.label; return grant(owner, { bound_to_connection: false }); }
      if (cmd === 'lease_renew') return success({ lease_id: 'ls_2_fixture', renewed: true });
      if (cmd === 'lease_release') return release();
      if (cmd === 'editor_run_console_command') { mode = Number(params.command.split(' ').at(-1)); return success({ executed: true }); }
      if (cmd === 'python_run') return success({ ok: true, stdout: `HAYBA_PIE_VETO ${mode}\n`, stderr: '' });
      if (cmd === 'editor_get_state') return success({ pie, building: [{ owner, label, asset: params.asset ?? '/game/__haybatest__/b8', expires_in_s: 250 }] });
      throw new Error(cmd);
    });
    ctx.state = async () => (await ctx.call('editor_get_state')).data;
    ctx.human = async (instruction: string, options: Reply) => {
      expect(options.timeoutMs).toBeGreaterThan(0); prompts.push(instruction);
      if (/Press Play again/.test(instruction)) pie = 'user';
      if (/mode 0.*Press Play/.test(instruction) && starts) pie = 'user';
      if (/Stop PIE/.test(instruction)) pie = 'none';
    };
    if (starts) await bStep('B8').run(ctx); else await expect(bStep('B8').run(ctx)).rejects.toThrow();
    expect(mode).toBe(1);
    expect(ctx.calls.at(-1).cmd).toBe('lease_release');
    const mode0 = prompts.findIndex((p) => /mode 0.*Press Play/.test(p));
    expect(prompts.slice(mode0 + 1).some((p) => /Stop PIE/.test(p))).toBe(starts);
    expect(ctx.calls.some((c: Call) => c.cmd === 'editor_start_pie')).toBe(false);
  });
  it('B4 preserves the refusal failure together with cleanup errors', async () => {
    const ctx = fileContext('map', ({ cmd, params }, r) => {
      if (cmd === 'python_run' && params.script.includes('SAVE_RESULT')) throw new Error('modal reply timeout');
      if (cmd === 'level_save') throw new Error('cleanup reply timeout');
      return r;
    });
    try {
      await expect(bStep('B4').run(ctx)).rejects.toThrow(/modal reply timeout; cleanup failed: cleanup reply timeout/);
      expect(fs.statSync(ctx.file()).mode & 0o200).toBe(0o200);
      expect(ctx.retainedFixtures[0].saved_clean).toBe(false);
    } finally { ctx.dispose(); }
  });
  it('B3 restores the observed mode before deleting after compile failure', async () => {
    const ctx = fileContext('asset', ({ cmd, params }, r) => {
      if (cmd === 'blueprint_compile' && params.save === false) throw new Error('compile failed');
      return r;
    });
    ctx.onDelete = () => expect(fs.statSync(ctx.file()).mode & 0o777).toBe(ctx.createdMode);
    try { await expect(bStep('B3').run(ctx)).rejects.toThrow(/compile failed/); } finally { ctx.dispose(); }
  });
  it('manual B7/B8 remain skipped without claiming a person checked them', async () => {
    const results = await runSteps(STEPS.b, {}, { only: ['B7', 'B8'] });
    expect(results.map((r: { status: string }) => r.status)).toEqual(['SKIP-MANUAL', 'SKIP-MANUAL']);
    expect(exitCodeFor(results)).toBe(3);
  });
});

describe('Deploy B framed TCP integration', () => {
  it('B10 uses fifty fresh sockets, unique correlation ids and omitted owner/lease envelopes', async () => {
    let holder = ''; let count = 0; let clock = 0;
    const ed = await fakeEditor((env) => {
      if (env.cmd === 'lease_acquire') { holder = env.owner!; return grant(holder); }
      if (env.cmd === 'lease_release') return release();
      count++; return refusal(holder, `conn:${count}`, 'owner_required', 'owner_missing', count);
    });
    const ctx = {
      now: () => clock, sleep: async (ms: number) => { clock += ms; },
      call: (cmd: string, params: Reply, opts: Reply) => once(ed.port, cmd, params, opts),
      logTail: () => ({ read: () => `Warning: [enforced_for_writes] owner_required: 'material_set_param' (write_scoped) names no owner while 1 other agents are connected (${holder}).\n`
        + (clock >= 30_000 ? `Warning: [enforced_for_writes] owner_required/owner_missing repeated 49 more times in 30 s: owner='conn:*' cmd='material_set_param' holder='${holder}' conflict='global'\n` : '') }),
    };
    try {
      await bStep('B10').run(ctx);
      const writes = ed.seen.filter((env) => env.cmd === 'material_set_param');
      expect(writes).toHaveLength(50);
      expect(ed.connections()).toBe(52);
      expect(new Set(writes.map((env) => env.id)).size).toBe(50);
      expect(new Set(writes.map((env) => JSON.stringify(env.params))).size).toBe(1);
      expect(writes.every((env) => !('owner' in env) && !('lease' in env))).toBe(true);
    } finally { await ed.close(); }
  });
});

function cStep(id: string) {
  const step = STEPS.c.find((s: { id: string }) => s.id === id);
  expect(step, `${id} must be implemented`).toBeDefined();
  return step;
}

function cContext(port: number) {
  let time = 0;
  return {
    retainedFixtures: [] as Reply[],
    now: () => time,
    sleep: async (ms: number) => { time += ms; },
    call: (cmd: string, params: Reply = {}, opts: Reply = {}) => once(port, cmd, params, opts),
    conn: (opts: Reply = {}) => new Conn(port, opts).open(),
  };
}

describe('Deploy C framed behavior', () => {
  it('C1 confirms every adoption field, the explicit override, and a fresh reconnect', async () => {
    let owner = ''; let released = false; const adopted = new Map<number, string>();
    const ed = await fakeEditor((env, conn) => {
      const caller = env.owner ?? adopted.get(conn) ?? `conn:${conn}`;
      if (env.cmd === 'lease_acquire') { owner = caller; return success({ owner, status: 'granted',
        lease_id: 'ls_2_c1', bound_to_connection: false, bind_connection: false,
        expires_in_s: 120, resources: [{ resource: env.params.resources[0], mode: 'exclusive' }] }); }
      if (env.cmd === 'lease_adopt') { adopted.set(conn, owner); return success({ adopted: true, owner,
        lease_id: env.params.lease_id, connection_owner: owner, expires_in_s: 100 }); }
      if (env.cmd === 'lease_status') return success({ caller_owner: caller, connection_owner: adopted.get(conn) ?? '' });
      if (env.cmd === 'lease_release') { released = true; return success({ lease_id: env.params.lease_id, released: true }); }
      throw new Error(env.cmd);
    }, (conn) => adopted.delete(conn));
    try {
      await cStep('C1').run(cContext(ed.port));
      expect(released).toBe(true);
      expect(ed.seen.filter((e) => e.cmd === 'lease_adopt')).toHaveLength(3);
      expect(ed.seen.filter((e) => e.cmd === 'lease_adopt').every((e) => !('owner' in e) && !('lease' in e))).toBe(true);
      expect(ed.seen.some((e) => e.cmd === 'lease_status' && e.owner?.includes('override'))).toBe(true);
    } finally { await ed.close(); }
  });

  it.each(['wrong-owner', 'wrong-connection-owner', 'expired'])('C1 rejects false adoption confirmation: %s', async (variant) => {
    let owner = ''; let released = false;
    const ed = await fakeEditor((env, conn) => {
      if (env.cmd === 'lease_acquire') { owner = env.owner!; return success({ owner, status: 'granted',
        lease_id: 'ls_2_c1', bound_to_connection: false, bind_connection: false,
        expires_in_s: 120, resources: [{ resource: env.params.resources[0], mode: 'exclusive' }] }); }
      if (env.cmd === 'lease_status') return success({ caller_owner: `conn:${conn}`, connection_owner: '' });
      if (env.cmd === 'lease_adopt') return success({ adopted: true,
        owner: variant === 'wrong-owner' ? 'foreign' : owner, lease_id: 'ls_2_c1',
        connection_owner: variant === 'wrong-connection-owner' ? 'foreign' : owner,
        expires_in_s: variant === 'expired' ? 0 : 100 });
      if (env.cmd === 'lease_release') { released = true; return success({ released: true, lease_id: env.params.lease_id }); }
      throw new Error(env.cmd);
    });
    try {
      await expect(cStep('C1').run(cContext(ed.port))).rejects.toThrow(/C1 adoption/);
      expect(released).toBe(true);
    } finally { await ed.close(); }
  });

  it.each(['valid', 'wrong-detail', 'wrong-advisory', 'accepted-foreign', 'adopted-fresh'])('C2 pins root refusal and sender identity: %s', async (variant) => {
    const ed = await fakeEditor((env, conn) => {
      if (env.cmd === 'lease_status') return success({ caller_owner: `conn:${conn}`,
        connection_owner: variant === 'adopted-fresh' ? 'foreign' : '' });
      if (env.cmd === 'ping' && env.owner && env.owner !== `conn:${conn}`) {
        if (variant === 'accepted-foreign') return success();
        return { ok: false, code: 'owner_reserved',
          owner: { claimed_owner: variant === 'wrong-detail' ? 'conn:999' : env.owner,
            caller_owner: `conn:${conn}`, conn },
          advisory: { state: variant === 'wrong-advisory' ? 'unknown' : 'input_rejected',
            mutation_status: 'not_started' } };
      }
      if (env.cmd === 'ping') return success();
      throw new Error(env.cmd);
    });
    try {
      if (variant === 'valid') await cStep('C2').run(cContext(ed.port));
      else await expect(cStep('C2').run(cContext(ed.port))).rejects.toThrow(
        variant === 'adopted-fresh' ? /C2 needs two distinct fresh synthetic callers/ : /C2 reserved-owner/);
      expect(ed.seen.filter((e) => e.cmd === 'ping').some((e) => e.owner === 'local')).toBe(variant === 'valid');
    } finally { await ed.close(); }
  });

  it.each(['valid', 'postterminal-absent', 'missing-envelope', 'accepted-no-id', 'wrong-job', 'wrong-caller', 'missing-orphan', 'missing-native-close',
    'truncated-step', 'pending-step', 'wrong-sentinel', 'wrong-lease-id', 'cleanup-timeout', 'initial-query-failure',
    'invalid-postterminal-expiry', 'timeout-batch'])(
    'C3 requires a framed close, exact final step witness, and bounded cleanup: %s', async (variant) => {
      let clock = 0; let watcher = ''; let batchConn = 0; let closed = false; let batchAccepted = false;
      let statusCalls = 0; let releases = 0;
      const leases: Reply[] = [];
      const withLeases = (caller: string) => leases.filter((l) =>
        ((variant === 'cleanup-timeout' && l.bind_connection) || clock < 60_000)
          && !(variant === 'postterminal-absent' && statusCalls > 0 && caller === watcher && !l.bind_connection))
        .map((l) => ({ ...l, mine: caller === l.owner,
          ...(caller === l.owner ? { lease_id: l.lease_id } : {}),
          ...(caller !== l.owner ? { lease_id: undefined } : {}),
          orphaned: l.bind_connection && closed && variant !== 'missing-orphan' && variant !== 'missing-native-close',
          bound_to_connection: l.bind_connection && (!closed || variant === 'missing-native-close'),
          expires_in_s: Math.max(1, 60 - clock / 1000) }));
      const ed = await fakeEditor((env, conn) => {
        const caller = env.owner ?? `conn:${conn}`;
        if (env.cmd === 'ping') {
          if (env.owner) watcher = env.owner;
          return success({ capabilities: { lease_id: true } });
        }
        if (env.cmd === 'editor_get_state') return success({ pie: 'none', editor_unsafe: false });
        if (env.cmd === 'lease_status') {
          if (variant === 'initial-query-failure' && statusCalls > 0 && caller === watcher)
            return { ok: false, code: 'query_failure', error: 'watcher status unavailable' };
          const visible = withLeases(caller);
          if (variant === 'invalid-postterminal-expiry' && statusCalls > 0 && caller === watcher) {
            for (const lease of visible) if (lease.bind_connection) lease.expires_in_s = null;
          }
          return success({ caller_owner: caller, connection_owner: '',
            enforcement: 'enforced_for_writes', leases: visible });
        }
        if (env.cmd === 'lease_acquire') {
          batchConn = conn; const bind = env.params.bind_connection === true;
          const l = { owner: caller, label: env.params.label, lease_id: bind ? 'ls_2_sentinel' : 'ls_2_batch',
            resources: [{ resource: env.params.resources[0], mode: 'exclusive' }],
            bind_connection: bind };
          leases.push(l);
          return success({ ...l, status: 'granted', bound_to_connection: bind, expires_in_s: 60 });
        }
        if (env.cmd === 'lease_release') { releases++; return success({ lease_id: env.params.lease_id, released: true }); }
        if (env.cmd === 'editor_batch') {
          if (variant === 'missing-envelope' && env.lease) return { ok: false, code: 'owner_required' };
          if (variant === 'accepted-no-id' && !env.lease) return success({ command: 'editor_batch', status: 'running' });
          if (!env.lease) return { ok: false, code: 'owner_required',
            lease: { command: 'editor_batch', caller_owner: caller, enforcement: 'enforced_for_writes', reason: 'owner_missing' } };
          batchAccepted = true;
          return success({ command: 'editor_batch', status: 'running', job_id: 'job_c3', owner: caller, steps_total: 3 });
        }
        if (env.cmd === 'batch_status') {
          statusCalls++;
          const owner = `conn:${batchConn}`;
          if (variant === 'timeout-batch') return success({ command: 'editor_batch', job_id: 'job_c3',
            owner, status: 'running', steps_total: 3, steps_run: 1 });
          const witness = { caller_owner: variant === 'wrong-caller' ? 'conn:999' : owner, connection_owner: '',
            leases: withLeases(owner).map((l) => variant === 'wrong-sentinel' && l.label?.startsWith('sentinel:')
              ? { ...l, label: 'wrong' }
              : variant === 'wrong-lease-id' && l.label?.startsWith('sentinel:')
                ? { ...l, lease_id: 'ls_2_foreign' } : l) };
          return success({ command: 'editor_batch', job_id: variant === 'wrong-job' ? 'other' : 'job_c3',
            owner, status: 'succeeded', steps_total: 3, steps_run: 3,
            steps: [
              { index: 0, cmd: 'ping', fence_after: 'idle', state: 'ok', data: { capabilities: { lease_id: true } } },
              { index: 1, cmd: 'ping', fence_after: 'none', state: variant === 'pending-step' ? 'pending' : 'ok',
                data: { capabilities: { lease_id: true } } },
              { index: 2, cmd: 'lease_status', fence_after: 'none', state: 'ok',
                ...(variant === 'truncated-step' ? { data_text: '{}', data_truncated: true } : { data: witness }) },
            ] });
        }
        throw new Error(env.cmd);
      }, (conn) => { if (conn === batchConn) closed = true; });
      const ctx = cContext(ed.port);
      ctx.now = () => clock;
      ctx.sleep = async (ms: number) => { clock += ms; };
      try {
        if (variant === 'valid' || variant === 'postterminal-absent') {
          await cStep('C3').run(ctx);
          expect(ctx.retainedFixtures).toHaveLength(0);
          expect(statusCalls).toBeGreaterThan(0);
          expect(ed.seen.filter((e) => e.cmd === 'editor_batch')).toHaveLength(2);
          const accepted = ed.seen.find((e) => e.cmd === 'editor_batch' && e.lease);
          expect(accepted?.params).toMatchObject({ idle_ticks: 3, fence_timeout_s: 30,
            steps: [{ cmd: 'ping', fence_after: 'idle' }, { cmd: 'ping', fence_after: 'none' },
              { cmd: 'lease_status', fence_after: 'none' }] });
          expect(accepted).not.toHaveProperty('owner');
          expect(closed).toBe(true);
          expect(releases).toBe(0);
          expect(watcher).toMatch(/^ladder-c3-watch-/);
        } else {
          if (variant === 'initial-query-failure' || variant === 'invalid-postterminal-expiry')
            await expect(cStep('C3').run(ctx)).rejects.toThrow(variant === 'initial-query-failure'
              ? /cleanup failed: incorrect lease_status/ : /cleanup failed: C3 post-terminal expiry unreadable/);
          else await expect(cStep('C3').run(ctx)).rejects.toThrow();
          if (variant === 'missing-envelope') expect(releases).toBe(2);
          else if (variant !== 'accepted-no-id') expect(batchAccepted).toBe(true);
          if (variant === 'accepted-no-id') {
            expect(ctx.retainedFixtures).toMatchObject([{ step: 'C3' }]);
            expect(releases).toBe(0);
          }
          if (variant === 'timeout-batch') {
            expect(ctx.retainedFixtures).toMatchObject([{ step: 'C3', job_id: 'job_c3' }]);
            expect(statusCalls).toBeGreaterThan(100);
          }
          if (variant === 'cleanup-timeout') {
            expect(ctx.retainedFixtures).toMatchObject([{
              step: 'C3', owner: `conn:${batchConn}`, job_id: 'job_c3',
              remaining: [{ label: expect.stringMatching(/^sentinel:/),
                resource: expect.stringMatching(/^asset:\/Game\/__HaybaTest__/),
                lease_id: 'ls_2_sentinel', state: 'visible' }],
              already_absent: [{ label: expect.stringMatching(/^batch:/), lease_id: 'ls_2_batch' }],
            }]);
            expect(ctx.retainedFixtures[0].observed_post_terminal[0].expires_in_s).toBeGreaterThan(0);
          }
          if (variant === 'initial-query-failure' || variant === 'invalid-postterminal-expiry') {
            expect(ctx.retainedFixtures).toMatchObject([{
              step: 'C3', owner: `conn:${batchConn}`, job_id: 'job_c3',
              reason: expect.stringContaining(variant === 'initial-query-failure'
                ? 'incorrect lease_status' : 'post-terminal expiry unreadable'),
              known: [
                { label: expect.stringMatching(/^batch:/), resource: expect.stringMatching(/^asset:\/Game\/__HaybaTest__/),
                  lease_id: 'ls_2_batch' },
                { label: expect.stringMatching(/^sentinel:/), resource: expect.stringMatching(/^asset:\/Game\/__HaybaTest__/),
                  lease_id: 'ls_2_sentinel' },
              ],
              current_state: variant === 'initial-query-failure' ? 'unknown' : 'observed',
            }]);
            if (variant === 'invalid-postterminal-expiry')
              expect(ctx.retainedFixtures[0].remaining).toMatchObject([{ label: expect.stringMatching(/^batch:/) },
                { label: expect.stringMatching(/^sentinel:/), expires_in_s: null }]);
          }
        }
      } finally { await ed.close(); }
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
  it('the Deploy C ladder is C1-C3, all automated', () => {
    expect(STEPS.c.map((s: { id: string }) => s.id)).toEqual(['C1', 'C2', 'C3']);
    expect(STEPS.c.some((s: { manual?: boolean }) => s.manual)).toBe(false);
  });
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
    expect(parseArgs(['--deploy', 'A', '--host-dir', 'UEScratch/host', '--only', 'A1,A2', '--manual'])).toMatchObject({ deploy: 'a', hostDir: 'UEScratch/host', only: ['A1', 'A2'], manual: true });
  });
  it('the Deploy A ladder is A1-A8, with the Play and restart steps manual', () => {
    expect(STEPS.a.map((s: { id: string }) => s.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A7b', 'A8']);
    expect(STEPS.a.filter((s: { manual?: boolean }) => s.manual).map((s: { id: string }) => s.id)).toEqual(['A3', 'A7b', 'A8']);
  });
});
