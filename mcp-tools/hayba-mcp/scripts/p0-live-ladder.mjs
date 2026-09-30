#!/usr/bin/env node
// p0-live-ladder.mjs: the P0 live-verification ladders (spec §6.5; plan GA.2, GB.2, GC.2).
//
// It drives ONLY the throwaway scratch GUI host: a project under a UEScratch
// directory, found through that project's own instance heartbeat, from a
// process outside the editor. Never run it from python_run (a socket from inside
// the editor to 52342-52350 deadlocks the game thread). Never point it at
// the consumer, and never run it while another agent drives the same editor.
//
//   node scripts/p0-live-ladder.mjs --deploy a|b|c [--host-dir D:\UEScratch\h58] [--only A1,A2] [--manual]
//
// Exit 0: every selected step passed. 1: a step failed. 2: bad arguments or no
// scratch host. 3: steps that need a person at the editor were skipped; rerun
// them with --manual while sitting at the scratch editor.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LEASE_ID_RE = /^ls_[a-z0-9_]+$/;
const SCRATCH_DIR_RE = /[\\/]UEScratch[\\/]/i;
const LANE_FALLBACK_PORT = 52342;

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The port of the one live editor of the scratch project at hostDir. */
export function findScratchPort(hostDir, isAlive = pidAlive) {
  const root = path.resolve(hostDir) + path.sep;
  if (!SCRATCH_DIR_RE.test(root)) {
    throw new Error(`refusing ${hostDir}: the ladder only drives a scratch host under a UEScratch directory`);
  }
  const dir = path.join(root, 'Saved', 'HaybaMCP', 'instances');
  const live = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((e) => e && Number.isInteger(e.pid) && Number.isInteger(e.port) && isAlive(e.pid));
  if (live.length !== 1) throw new Error(`expected one live scratch editor in ${dir}, found ${live.length}`);
  const [entry] = live;
  if (typeof entry.project_dir === 'string' && !SCRATCH_DIR_RE.test(path.resolve(entry.project_dir) + path.sep)) {
    throw new Error(`the heartbeat names ${entry.project_dir}, which is not a scratch project`);
  }
  if (entry.port === LANE_FALLBACK_PORT) {
    throw new Error('the scratch host holds 52342, the port lane MCP servers fall back to; relaunch it while another editor holds 52342 (R-5)');
  }
  return entry.port;
}

/** One persistent framed connection (4-byte big-endian length + UTF-8 JSON). */
export class Conn {
  constructor(port, { owner = null, lease = null, auth = process.env.HAYBA_AUTH || null } = {}) {
    this.port = port;
    this.owner = owner;
    this.lease = lease;
    this.auth = auth;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      let connected = false;
      const s = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        connected = true;
        resolve(this);
      });
      s.on('data', (d) => this.onData(d));
      s.on('error', (e) => {
        if (!connected) reject(e);
      });
      s.on('close', () => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('connection closed'));
        }
        this.pending.clear();
      });
      this.socket = s;
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) return;
      const reply = JSON.parse(this.buffer.subarray(4, 4 + len).toString('utf8'));
      this.buffer = this.buffer.subarray(4 + len);
      const p = this.pending.get(reply.id);
      if (p) {
        this.pending.delete(reply.id);
        clearTimeout(p.timer);
        p.resolve(reply);
      }
    }
  }

  send(cmd, params = {}, { owner = this.owner, lease = this.lease, timeoutMs = 30_000 } = {}) {
    if (this.closed || !this.socket) return Promise.reject(new Error(`${cmd}: connection closed`));
    const id = `ladder_${randomUUID()}`;
    const envelope = { cmd, id, params };
    if (owner) envelope.owner = owner;
    if (lease) envelope.lease = lease;
    if (this.auth) envelope.auth = this.auth;
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd}: no reply in ${timeoutMs} ms (a modal dialog on the game thread would do this)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([head, body]));
    });
  }

  close() {
    this.socket?.destroy();
    this.closed = true;
  }
}

/** Per-call mode: a fresh connection for one command, like invoke-tcp-command.ps1 (R-9). */
export async function once(port, cmd, params = {}, opts = {}) {
  const c = await new Conn(port, opts).open();
  try {
    return await c.send(cmd, params, opts);
  } finally {
    c.close();
  }
}

export function check(cond, message) {
  if (!cond) throw new Error(message);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what, probe, capMs = 20_000, everyMs = 500) {
  const deadline = Date.now() + capMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${capMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** The text the scratch editor appended to its log since this object was made. */
export class LogTail {
  constructor(file) {
    this.file = file;
    this.offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  read() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.max(0, size - this.offset));
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  lines(re) {
    return this.read().split(/\r?\n/).filter((l) => re.test(l));
  }
}

export async function runSteps(steps, ctx, { only = null, manual = false } = {}) {
  const results = [];
  for (const step of steps) {
    if (only && !only.includes(step.id)) continue;
    if (step.manual && !manual) {
      results.push({ id: step.id, title: step.title, status: 'SKIP-MANUAL' });
      continue;
    }
    const started = Date.now();
    try {
      await step.run(ctx);
      results.push({ id: step.id, title: step.title, status: 'PASS', ms: Date.now() - started });
    } catch (e) {
      results.push({ id: step.id, title: step.title, status: 'FAIL', error: String(e?.message ?? e) });
    }
  }
  return results;
}

export function exitCodeFor(results) {
  if (results.some((r) => r.status === 'FAIL')) return 1;
  if (results.some((r) => r.status === 'SKIP-MANUAL')) return 3;
  return 0;
}

export function parseArgs(argv) {
  const out = { deploy: null, hostDir: 'D:\\UEScratch\\h58', only: null, manual: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deploy') out.deploy = String(argv[++i] ?? '').toLowerCase();
    else if (a === '--host-dir') out.hostDir = argv[++i];
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--manual') out.manual = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['a', 'b', 'c'].includes(out.deploy)) throw new Error('--deploy a|b|c is required');
  return out;
}

export function makeCtx({ port, hostDir, rl }) {
  const uproject = fs.readdirSync(hostDir).find((f) => f.endsWith('.uproject'));
  if (!uproject) throw new Error(`no .uproject in ${hostDir}`);
  const ctx = {
    port,
    hostDir,
    logFile: path.join(hostDir, 'Saved', 'Logs', `${path.basename(uproject, '.uproject')}.log`),
    call: (cmd, params = {}, opts = {}) => once(ctx.port, cmd, params, opts),
    conn: (opts = {}) => new Conn(ctx.port, opts).open(),
    state: async () => (await ctx.call('editor_get_state', { include_dirty: false })).data ?? {},
    contentFile: (pkg, ext) => path.join(hostDir, 'Content', ...pkg.replace(/^\/Game\//, '').split('/')) + ext,
    human: async (instruction) => {
      const answer = await rl.question(`\n  >> ${instruction}\n     Press Enter when done, or type fail: `);
      check(answer.trim().toLowerCase() !== 'fail', `the person at the editor reported a failure: ${instruction}`);
    },
  };
  return ctx;
}

// ----------------------------------------------------------------------------- Deploy A (A1-A8)

const A_STEPS = [
  {
    id: 'A1',
    title: 'ping reports editor health',
    run: async (ctx) => {
      const r = await ctx.call('ping');
      check(r.ok, `ping failed: ${r.error}`);
      check(r.data?.capabilities?.editor_health === true, 'capabilities.editor_health is not true');
      check(r.data?.editor_unsafe === false, 'editor_unsafe is not false');
      check(r.data?.health && typeof r.data.health === 'object', 'ping has no health object');
    },
  },
  {
    id: 'A2',
    title: 'editor_get_state without the dirty walk',
    run: async (ctx) => {
      const r = await ctx.call('editor_get_state', { include_dirty: false });
      check(r.ok, `editor_get_state failed: ${r.error}`);
      check(r.data.pie === 'none', `pie is ${r.data.pie}`);
      check(Array.isArray(r.data.building) && r.data.building.length === 0, 'building is not an empty array');
      check(r.data.editor_unsafe === false && 'health' in r.data, 'health fields missing');
      check(r.data.dirty_packages_skipped === 'include_dirty', `dirty_packages_skipped is ${r.data.dirty_packages_skipped}`);
    },
  },
  {
    id: 'A3',
    title: 'a user PIE refuses agent writes, and nobody stops it',
    manual: true,
    run: async (ctx) => {
      await ctx.human('Press Play in the scratch editor.');
      await waitFor('pie == user', async () => (await ctx.state()).pie === 'user');
      const tail = new LogTail(ctx.logFile);
      for (let i = 0; i < 5; i++) {
        const r = await ctx.call('blueprint_add_node', { path: '/Game/__HaybaTest__/BP_Ladder', node_type: 'branch' }, { owner: 'ladder-a3' });
        check(r.code === 'pie_active', `blueprint_add_node #${i + 1}: expected pie_active, got ${r.code ?? r.error ?? 'ok'}`);
      }
      const stop = await ctx.call('editor_stop_pie', {}, { owner: 'ladder-a3' });
      check(stop.code === 'pie_active', `editor_stop_pie of a user PIE: expected pie_active, got ${stop.code ?? 'ok'}`);
      await sleep(1000);
      const warnings = tail.lines(/Warning:.*pie_active.*blueprint_add_node/);
      check(warnings.length === 1, `expected 1 rate-limited pie_active Warning for blueprint_add_node, found ${warnings.length}`);
      await ctx.human('Stop PIE in the scratch editor.');
      await waitFor('pie == none', async () => (await ctx.state()).pie === 'none');
    },
  },
  {
    id: 'A4',
    title: 'agent PIE: only its owner drives it; anyone may stop it',
    run: async (ctx) => {
      const a = await ctx.conn();
      const b = await ctx.conn();
      try {
        const ownerA = (await a.send('lease_status')).data?.caller_owner;
        const ownerB = (await b.send('lease_status')).data?.caller_owner;
        const tail = new LogTail(ctx.logFile);
        const start = await a.send('editor_start_pie', {});
        check(start.ok && start.data?.pie_requested === true, `editor_start_pie: ${start.code ?? start.error}`);
        check(start.data.pie_owner === `agent:${ownerA}`, `pie_owner is ${start.data.pie_owner}, expected agent:${ownerA}`);
        await waitFor('agent PIE', async () => (await b.send('editor_get_state', { include_dirty: false })).data?.pie === `agent:${ownerA}`);
        const drive = await b.send('editor_pie_press_key', { key: 'SpaceBar' });
        check(drive.code === 'pie_active', `non-owner drive: expected pie_active, got ${drive.code ?? 'ok'}`);
        const stop = await b.send('editor_stop_pie', {});
        check(stop.ok, `non-owner stop of an agent PIE failed: ${stop.code ?? stop.error}`);
        await waitFor('pie == none', async () => (await b.send('editor_get_state', { include_dirty: false })).data?.pie === 'none');
        const named = tail.lines(/Warning:.*editor_stop_pie/).filter((l) => l.includes(ownerA) && l.includes(ownerB));
        check(named.length >= 1, 'no Warning naming both owners for the non-owner stop');
      } finally {
        a.close();
        b.close();
      }
    },
  },
  {
    id: 'A5',
    title: "another owner's build lease refuses editor_start_pie",
    run: async (ctx) => {
      const g = await ctx.call('lease_acquire', {
        resources: ['asset:/Game/__HaybaTest__/BP_Busy'], ttl_s: 15, bind_connection: false, label: 'build:ladder', lane: 'long',
      }, { owner: 'ladder-builder' });
      check(g.ok && g.data?.status === 'granted', `lease_acquire: ${g.code ?? g.error ?? g.data?.status}`);
      const r = await ctx.call('editor_start_pie', {}, { owner: 'ladder-lane5' });
      check(r.code === 'asset_busy', `expected asset_busy, got ${r.code ?? 'ok'}`);
      check((r.busy?.assets ?? []).some((x) => x.owner === 'ladder-builder' && x.label === 'build:ladder'),
        'busy.assets does not name the builder and its label');
      if (LEASE_ID_RE.test(g.data.lease_id ?? '')) {
        await ctx.call('lease_release', { lease_id: g.data.lease_id }, { owner: 'ladder-builder' });
      }
      // Before Deploy B the handle is redacted and cannot be released: let it lapse.
      await waitFor('the build lease lapses', async () => ((await ctx.state()).building ?? []).length === 0, 30_000, 1_000);
    },
  },
  {
    id: 'A6',
    title: 'a Blueprint in error refuses editor_start_pie with pie_blocked and no modal',
    run: async (ctx) => {
      const bp = '/Game/__HaybaTest__/BP_LadderBroken';
      const o = { owner: 'ladder-a6' };
      const made = await ctx.call('blueprint_create', { name: 'BP_LadderBroken', package_path: bp, parent_class_path: '/Script/Engine.Actor' }, o);
      check(made.ok || /already exists/i.test(made.error ?? ''), `blueprint_create: ${made.error}`);
      try {
        // A function graph always compiles, so an unresolved wildcard in it is an error
        // (an event-graph node could be pruned as unreachable instead).
        const fn = await ctx.call('blueprint_add_function', { path: bp, function_name: 'LadderBroken' }, o);
        check(fn.ok || /already|exists|conflict/i.test(fn.error ?? ''), `blueprint_add_function: ${fn.error}`);
        const graph = await ctx.call('blueprint_inspect_graph', { path: bp, graph_name: 'LadderBroken' }, o);
        const nodes = graph.data?.nodes ?? [];
        const entry = nodes.find((n) => (n.pins ?? []).some((p) => p.name === 'then' && p.direction === 'output')) ?? nodes[0];
        const entryId = entry?.node_id ?? entry?.id;
        check(entryId, 'the function graph has no entry node');
        const clear = await ctx.call('blueprint_add_node', {
          path: bp, graph_name: 'LadderBroken', node_type: 'call_function',
          class_path: '/Script/Engine.KismetArrayLibrary', function_name: 'Array_Clear',
        }, o);
        check(clear.ok && clear.data?.node_id, `blueprint_add_node Array_Clear: ${clear.error}`);
        const wire = await ctx.call('blueprint_connect_nodes', {
          path: bp, graph_name: 'LadderBroken', from_node: entryId, from_pin: 'then', to_node: clear.data.node_id, to_pin: 'execute',
        }, o);
        check(wire.ok, `blueprint_connect_nodes: ${wire.error}`);
        await ctx.call('blueprint_compile', { path: bp, save: false }, o);
        const r = await ctx.call('editor_start_pie', {}, { ...o, timeoutMs: 15_000 });
        check(r.code === 'pie_blocked', `expected pie_blocked, got ${r.code ?? 'ok'}`);
        check((r.data?.blocked_assets ?? []).some((x) => String(x.asset).includes('BP_LadderBroken')), 'blocked_assets does not name BP_LadderBroken');
        await sleep(3000);
        check((await ctx.state()).pie === 'none', 'a PIE started anyway');
      } finally {
        await ctx.call('python_run', { script: `import unreal\nunreal.EditorAssetLibrary.delete_asset('${bp}')` }, o);
      }
    },
  },
  {
    id: 'A7',
    title: 'a contained Python fault makes the editor unsafe until restart (R-15, throwaway host only)',
    run: async (ctx) => {
      const o = { owner: 'ladder-a7' };
      const tail = new LogTail(ctx.logFile);
      // T1.3 scans LogPython Error lines and Hayba's own failure text, never stdout or a
      // raised exception (R-15), so the trigger is a LogPython Error line with a marker.
      const fault = await ctx.call('python_run', { script: "import unreal\nunreal.log_error('SystemError: unknown opcode')" }, o);
      check(fault.code === 'native_fault_contained', `expected native_fault_contained, got ${fault.code ?? 'ok'}: ${fault.error}`);
      const after = await ctx.call('python_run', { script: 'print(1)' }, o);
      check(after.code === 'editor_unsafe_restart_required', `expected editor_unsafe_restart_required, got ${after.code ?? 'ok'}`);
      const ping = await ctx.call('ping', {}, o);
      check(ping.ok && ping.data?.editor_unsafe === true && ping.data?.python_unhealthy === true, 'ping does not report editor_unsafe and python_unhealthy');
      check((await ctx.call('editor_get_state', { include_dirty: false }, o)).ok, 'editor_get_state is refused while unsafe');
      check((await ctx.call('lease_status', {}, o)).ok, 'lease_status is refused while unsafe');
      await sleep(2000);
      const text = tail.read();
      const f = /\[(HCR-NATIVE-00\d)\] editor_unsafe: native fault .*?frame (\d+)\)/.exec(text);
      const n = /editor_unsafe: user notified \(cause (\w+), frame (\d+)\)/.exec(text);
      check(f && n, 'missing the fault Error line or the user-notified line');
      check(Number(n[2]) <= Number(f[2]) + 1, `notified at frame ${n[2]}, fault at frame ${f[2]} (M8 needs at most one frame later)`);
    },
  },
  {
    id: 'A7b',
    title: 'the person at the editor sees the notification, and Play is refused',
    manual: true,
    run: async (ctx) => {
      await ctx.human("Confirm a persistent notification starting \"Hayba contained a native fault in 'python_run'\" is on screen.");
      await ctx.human('Press Play. Confirm it is refused with "Hayba: the editor is unsafe after a contained native fault" and no PIE starts.');
      check((await ctx.state()).pie === 'none', 'a PIE is running after the refused Play');
    },
  },
  {
    id: 'A8',
    title: 'an editor restart clears the unsafe state',
    manual: true,
    run: async (ctx) => {
      await ctx.human('Close the scratch editor without saving, relaunch it with the GA.2 Step 8 launch block, and wait until it has loaded.');
      ctx.port = await waitFor('a live scratch heartbeat', async () => {
        try {
          return findScratchPort(ctx.hostDir);
        } catch {
          return null;
        }
      }, 300_000, 2_000);
      const p = await ctx.call('ping');
      check(p.ok && p.data?.editor_unsafe === false, 'editor_unsafe is still set after the restart');
    },
  },
];

export const STEPS = { a: A_STEPS, b: [], c: [] };

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e?.message ?? e));
    return 2;
  }
  const steps = STEPS[args.deploy];
  if (steps.length === 0) {
    console.error(`no ladder steps for deploy ${args.deploy} yet`);
    return 2;
  }
  let port;
  try {
    port = findScratchPort(args.hostDir);
  } catch (e) {
    console.error(String(e?.message ?? e));
    return 2;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ctx = makeCtx({ port, hostDir: args.hostDir, rl });
    const results = await runSteps(steps, ctx, { only: args.only, manual: args.manual });
    for (const r of results) console.log(JSON.stringify(r));
    return exitCodeFor(results);
  } finally {
    rl.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
