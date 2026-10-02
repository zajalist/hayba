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
    const retainedBefore = ctx.retainedFixtures?.length ?? 0;
    try {
      await step.run(ctx);
      results.push({ id: step.id, title: step.title, status: 'PASS', ms: Date.now() - started });
    } catch (e) {
      results.push({ id: step.id, title: step.title, status: 'FAIL', error: String(e?.message ?? e) });
    }
    const retained = ctx.retainedFixtures?.slice(retainedBefore);
    if (retained?.length) results.at(-1).retained_fixtures = retained;
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
    human: async (instruction, { timeoutMs } = {}) => {
      const answer = await rl.question(`\n  >> ${instruction}\n     Press Enter when done, or type fail: `,
        timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {});
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

// ----------------------------------------------------------------------------- Deploy B (B1-B10)

const bNow = (ctx) => ctx.now ? ctx.now() : Date.now();
const bSleep = (ctx, ms) => ctx.sleep ? ctx.sleep(ms) : sleep(ms);
const bTail = (ctx) => ctx.logTail ? ctx.logTail() : new LogTail(ctx.logFile);
const bName = (id) => `ladder-${id.toLowerCase()}-${randomUUID().replaceAll('-', '')}`;
const bParams = { instance_path: '/Game/__HaybaTest__/MI_None', param_name: 'X', value: 1 };

async function bWait(ctx, what, probe, capMs = 20_000, everyMs = 500) {
  const deadline = bNow(ctx) + capMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    check(bNow(ctx) < deadline, `timed out after ${capMs} ms waiting for ${what}`);
    await bSleep(ctx, everyMs);
  }
}

// Keep the original failure and every cleanup failure visible in the step result.
async function bWithCleanup(work, cleanup) {
  let failure;
  try { await work(); } catch (e) { failure = e; }
  const errors = [];
  for (const action of cleanup) {
    try { await action(); } catch (e) { errors.push(String(e?.message ?? e)); }
  }
  if (errors.length) throw new Error(`${failure ? `${failure.message}; ` : ''}cleanup failed: ${errors.join('; ')}`);
  if (failure) throw failure;
}

function bGrant(r, owner, bound, held = {}) {
  // Remember only this unique owner's handle before further assertions can fail.
  if (r.ok === true && r.data?.owner === owner) {
    if (r.data.status === 'granted' && LEASE_ID_RE.test(r.data.lease_id ?? '')) held.lease_id = r.data.lease_id;
    if (r.data.status === 'queued' && typeof r.data.ticket === 'string' && r.data.ticket) held.ticket = r.data.ticket;
  }
  check(r.ok === true && r.data?.status === 'granted' && LEASE_ID_RE.test(r.data?.lease_id ?? ''), `lease_acquire did not grant: ${JSON.stringify(r)}`);
  check(r.data.owner === owner, 'lease_acquire returned another owner');
  check(!('token' in r.data), 'lease_acquire returned a token');
  if (bound !== undefined) check(r.data.bound_to_connection === bound, `lease_acquire bound_to_connection must be ${bound}`);
  return r.data.lease_id;
}

async function bRelease(send, handle) {
  const params = typeof handle === 'string' ? { lease_id: handle } : handle;
  const field = params.lease_id ? 'lease_id' : 'ticket';
  if (!params[field]) return;
  const r = await send('lease_release', params);
  check(r.ok === true && r.data?.released === true && r.data?.[field] === params[field], `lease_release failed: ${JSON.stringify(r)}`);
}

function bPython(r) {
  check(r.ok === true && r.data?.ok === true, `python_run failed: ${r.code ?? r.error ?? JSON.stringify(r.data)}`);
  check(typeof r.data.stdout === 'string' && !(r.data.stderr ?? '').trim(), `python_run has missing stdout or stderr: ${r.data.stderr}`);
  check(!r.data.stdout_truncated && !r.data.stderr_truncated, 'Python output was truncated');
  return r.data.stdout.split(/\r?\n/);
}

function bReadOnly(r, file, compile = false) {
  check(r.ok === false && r.code === 'package_read_only' && r.data?.code === 'package_read_only', `expected package_read_only refusal: ${JSON.stringify(r)}`);
  check(typeof r.data.make_writable_hint === 'string' && r.data.make_writable_hint.trim().length > 0, 'missing make_writable_hint');
  if (compile) check(/save\s*:\s*false/.test(r.data.make_writable_hint), 'compile hint lacks save:false alternative');
  check(Array.isArray(r.data.read_only_files) && r.data.read_only_files.some((f) => path.resolve(f).toLowerCase() === path.resolve(file).toLowerCase()), 'read_only_files does not name the fixture');
}

function bFileMode(file) {
  check(fs.existsSync(file), `fixture file is missing: ${file}`);
  return fs.statSync(file).mode & 0o777;
}
function bSetMode(file, mode) {
  fs.chmodSync(file, mode);
  // On Windows Node derives write bits from the observed READONLY attribute.
  check((bFileMode(file) & 0o200) === (mode & 0o200), `file attribute did not change as requested: ${file}`);
}

const MAP_STATE_SCRIPT = "import unreal, json\nw = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()\np = w.get_path_name().split('.')[0]\nprint('HAYBA_MAP_STATE ' + json.dumps({'path': p, 'dirty': any(x.get_path_name() == p for x in unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages())}))";

async function bMapState(ctx, pkg, owner, dirty) {
  const r = await ctx.call('python_run', { script: MAP_STATE_SCRIPT }, { owner, timeoutMs: 30_000 });
  const lines = bPython(r).filter((line) => line.startsWith('HAYBA_MAP_STATE '));
  check(lines.length === 1, 'missing unique map state marker');
  const state = JSON.parse(lines[0].slice('HAYBA_MAP_STATE '.length));
  check(state.path === pkg, `current map is ${state.path}, expected ${pkg}`);
  if (dirty !== undefined) check(state.dirty === dirty, `current map dirty=${state.dirty}, expected ${dirty}`);
}

async function bMap(ctx, id, refuse) {
  const name = `L_${bName(id).replaceAll('-', '_')}`;
  const pkg = `/Game/__HaybaTest__/${name}`;
  const owner = bName(id);
  const opts = { owner, timeoutMs: 30_000 };
  const file = ctx.contentFile(pkg, '.umap');
  let originalMode;
  let created = false;
  await bWithCleanup(async () => {
    const made = await ctx.call('level_create', { path: pkg }, opts);
    created = made.ok === true && made.data?.world_changed === true;
    // Record any changed world, even a partial create, for controller recovery.
    if (made.data?.world_changed || made.data?.created) {
      created = true;
      (ctx.retainedFixtures ??= []).push({ step: id, package: pkg, file, saved_clean: false });
    }
    check(made.ok === true && made.data?.created === true && made.data?.saved === true && made.data?.verified === true
      && made.data.path === pkg && made.data.observed_path === pkg, `level_create did not verify ${pkg}: ${JSON.stringify(made)}`);
    originalMode = bFileMode(file);
    check((originalMode & 0o200) !== 0, `new map unexpectedly read-only: ${file}`);
    await bMapState(ctx, pkg, owner, false);
    bSetMode(file, originalMode & ~0o222);
    bPython(await ctx.call('python_run', { script: 'import unreal\nunreal.EditorLevelLibrary.spawn_actor_from_class(unreal.Actor, unreal.Vector(0, 0, 0))' }, opts));
    await bMapState(ctx, pkg, owner, true);
    check((bFileMode(file) & 0o200) === 0, 'dirty target map is no longer read-only');
    await refuse({ pkg, file, opts });
  }, [
    async () => { if (originalMode !== undefined) bSetMode(file, originalMode); },
    async () => {
      if (!created) return;
      await bMapState(ctx, pkg, owner);
      const saved = await ctx.call('level_save', {}, opts);
      check(saved.ok === true && saved.data?.saved === true && saved.data?.verified === true && saved.data?.dirty === false, `level_save did not restore saved/verified state for ${pkg}: ${JSON.stringify(saved)}`);
      bFileMode(file);
      await bMapState(ctx, pkg, owner, false);
      const retained = ctx.retainedFixtures.find((f) => f.package === pkg);
      if (retained) retained.saved_clean = true;
    },
  ]);
}

function bRefusal(r, holder, caller) {
  const code = caller ? 'lease_conflict' : 'owner_required';
  const reason = caller ? 'held' : 'owner_missing';
  const d = r.lease;
  check(r.ok === false && r.code === code && d?.code === code && d.enforcement === 'enforced_for_writes'
    && d.reason === reason && d.command === 'material_set_param' && d.access_class === 'write_scoped'
    && d.holder_owner === holder, `incorrect ${code} detail: ${JSON.stringify(r)}`);
  check(!('token' in r) && !('token' in d) && !('lease_id' in d), 'refusal leaks a holder handle');
  if (caller) check(d.caller_owner === caller, 'conflict names the wrong caller');
  else check(/^conn:\d+$/.test(d.caller_owner ?? '') && d.other_owners?.includes(holder), 'anonymous refusal lacks synthetic caller or holder presence');
  return d;
}

async function bState(ctx) {
  const r = await ctx.call('editor_get_state', { include_dirty: false });
  check(r.ok === true && r.data, `editor_get_state failed: ${r.error}`);
  return r.data;
}

async function bVetoMode(ctx, mode, opts) {
  check((await bState(ctx)).pie === 'none', 'CVar readback requires PIE stopped');
  const r = await ctx.call('editor_run_console_command', { command: `hayba.PIEBuildVeto ${mode}` }, opts);
  check(r.ok === true && r.data?.executed === true, `CVar command failed: ${JSON.stringify(r)}`);
  const read = await ctx.call('python_run', { script: "import unreal\nprint('HAYBA_PIE_VETO', unreal.SystemLibrary.get_console_variable_int_value('hayba.PIEBuildVeto'))" }, opts);
  check(bPython(read).filter((l) => l === `HAYBA_PIE_VETO ${mode}`).length === 1, `CVar readback is not ${mode}`);
}

const B_STEPS = [
  { id: 'B1', title: 'ping reports lease_id, enforced_for_writes and owner_required', run: async (ctx) => {
    const r = await ctx.call('ping');
    check(r.ok === true, `ping failed: ${r.error}`);
    const caps = r.data?.capabilities;
    check(caps?.lease_id === true && caps.lease_enforcement === 'enforced_for_writes' && caps.owner_required === true, `incorrect capabilities: ${JSON.stringify(caps)}`);
  } },
  { id: 'B2', title: 'lease id renewals, one executed ping batch and checked release', run: async (ctx) => {
    const owner = bName('B2'); const tail = bTail(ctx);
    const c = await ctx.conn({ owner }); let id; const held = {};
    await bWithCleanup(async () => {
      id = bGrant(await c.send('lease_acquire', { resources: [`asset:/Game/__HaybaTest__/${owner}`], ttl_s: 60 }), owner, undefined, held);
      const byId = await c.send('lease_renew', { lease_id: id, ttl_s: 60 });
      check(byId.ok === true && byId.data?.renewed === true && byId.data.lease_id === id, 'renew by id failed or changed the id');
      const byOwner = await c.send('lease_renew', {});
      check(byOwner.ok === true && typeof byOwner.data?.renewed === 'number' && byOwner.data.renewed >= 1
        && byOwner.data.owner === owner && byOwner.data.leases?.some((l) => l.lease_id === id), 'renew by owner lacks numeric count/own lease');
      const batch = await c.send('editor_batch', { lease_id: id, steps: [{ cmd: 'ping', fence_after: 'none' }] });
      check(batch.ok === true && typeof batch.data?.job_id === 'string' && batch.data.job_id.length > 0, 'editor_batch failed');
      const done = await bWait(ctx, 'the ping batch finishes', async () => {
        const s = await c.send('batch_status', { job_id: batch.data.job_id });
        check(s.ok === true && s.data?.job_id === batch.data.job_id && s.data.owner === owner, 'batch_status failed or returned another job');
        return ['succeeded', 'failed'].includes(s.data.status) ? s.data : null;
      }, 30_000);
      check(done.status === 'succeeded' && done.steps_total === 1 && done.steps_run === 1 && done.steps?.length === 1
        && done.steps[0].index === 0 && done.steps[0].cmd === 'ping' && done.steps[0].state === 'ok' && done.steps[0].data?.capabilities?.lease_id === true, 'batch did not execute exactly one successful ping');
    }, [async () => { await bRelease(c.send.bind(c), held); }, () => c.close()]);
    check(tail.lines(/unknown or expired/).length === 0, 'attempt log contains unknown or expired');
  } },
  { id: 'B3', title: 'read-only Blueprint save refusal and save:false compile', run: async (ctx) => {
    const name = `BP_${bName('B3').replaceAll('-', '_')}`; const pkg = `/Game/__HaybaTest__/${name}`;
    const opts = { owner: bName('B3') }; const file = ctx.contentFile(pkg, '.uasset');
    let objectPath; let originalMode; let owned = false;
    await bWithCleanup(async () => {
      const made = await ctx.call('blueprint_create', { name, package_path: pkg, parent_class_path: '/Script/Engine.Actor' }, opts);
      objectPath = made.data?.path;
      owned = made.ok === true && objectPath === `${pkg}.${name}`;
      check(owned && made.data.saved === true && made.data.dirty === false, `Blueprint was not saved at the owned path: ${JSON.stringify(made)}`);
      originalMode = bFileMode(file);
      check((originalMode & 0o200) !== 0, 'new Blueprint is unexpectedly read-only');
      bSetMode(file, originalMode & ~0o222);
      bReadOnly(await ctx.call('blueprint_compile', { path: objectPath, save: true }, opts), file, true);
      const compiled = await ctx.call('blueprint_compile', { path: objectPath, save: false }, opts);
      check(compiled.ok === true && compiled.data?.ok === true && compiled.data.compiled === true && compiled.data.save_requested === false, `save:false compile failed: ${JSON.stringify(compiled)}`);
    }, [
      async () => { if (originalMode !== undefined) bSetMode(file, originalMode); },
      async () => {
        if (!owned) return;
        if (fs.existsSync(file)) check((bFileMode(file) & 0o200) !== 0, `restore writability before deleting owned asset: ${pkg}`);
        const deleted = await ctx.call('python_run', { script: `import unreal\np = ${JSON.stringify(pkg)}\nprint('HAYBA_DELETE_RESULT', unreal.EditorAssetLibrary.delete_asset(p) and not unreal.EditorAssetLibrary.does_asset_exist(p))` }, opts);
        check(bPython(deleted).includes('HAYBA_DELETE_RESULT True') && !fs.existsSync(file), `owned asset deletion failed: ${pkg}`);
      },
    ]);
  } },
  { id: 'B4', title: 'Python read-only dirty map save returns False without a modal', run: async (ctx) => {
    await bMap(ctx, 'B4', async ({ opts }) => {
      const r = await ctx.call('python_run', { script: "import unreal\nprint('SAVE_RESULT', unreal.EditorLevelLibrary.save_current_level())" }, opts);
      check(bPython(r).filter((l) => l === 'SAVE_RESULT False').length === 1, 'Python stdout lacks exact SAVE_RESULT False');
    });
  } },
  { id: 'B5', title: 'level_save refuses its own read-only dirty map without a modal', run: async (ctx) => {
    await bMap(ctx, 'B5', async ({ file, opts }) => bReadOnly(await ctx.call('level_save', {}, opts), file));
  } },
  { id: 'B6', title: 'direct framed TCP idle drop, orphan and owner-renew rebind', run: async (ctx) => {
    const owner = bName('B6'); let c1; let c2; let id; const held = {};
    await bWithCleanup(async () => {
      c1 = await ctx.conn({ owner });
      id = bGrant(await c1.send('lease_acquire', { resources: [`asset:/Game/__HaybaTest__/${owner}`], ttl_s: 120 }), owner, true, held);
      await bSleep(ctx, 10_000);
      check(c1.closed, 'raw connection was not dropped after 10 s idle allowance');
      c2 = await ctx.conn({ owner });
      const find = async () => { const s = await c2.send('lease_status'); check(s.ok === true, 'lease_status failed'); return s.data?.leases?.find((l) => l.lease_id === id); };
      const orphan = await find();
      check(orphan?.orphaned === true && orphan.bound_to_connection === false, 'idle lease is missing or not orphaned/unbound');
      const renewed = await c2.send('lease_renew', {});
      check(renewed.ok === true && typeof renewed.data?.renewed === 'number' && renewed.data.renewed >= 1 && renewed.data.owner === owner, 'owner renewal failed');
      const revived = await find();
      check(revived?.orphaned === false && revived.bound_to_connection === true, 'lease did not rebind');
    }, [async () => { await bRelease(c2 ? c2.send.bind(c2) : (cmd, params) => ctx.call(cmd, params, { owner }), held); }, () => c2?.close(), () => c1?.close()]);
  } },
  { id: 'B7', title: 'Project Settings lease enforcement switches live', manual: true, run: async (ctx) => {
    let restored = false;
    try {
      await ctx.human('Project Settings > Hayba MCP Toolkit > Lease Enforcement = Advisory.');
      const a = await ctx.call('ping'); check(a.ok === true && a.data?.capabilities?.lease_enforcement === 'advisory', 'ping does not report advisory');
      await ctx.human('Set Lease Enforcement back to Enforced For Writes.');
      const e = await ctx.call('ping'); check(e.ok === true && e.data?.capabilities?.lease_enforcement === 'enforced_for_writes', 'ping does not report enforced_for_writes');
      restored = true;
    } catch (e) { throw new Error(`${e.message}${restored ? '' : '; restore Project Settings > Hayba MCP Toolkit > Lease Enforcement to Enforced For Writes and verify ping before continuing'}`); }
  } },
  { id: 'B8', title: 'human Play veto/second press and mode-zero notification', manual: true, run: async (ctx) => {
    const owner = bName('B8'); const label = `build:${owner}`; const opts = { owner }; let id; const held = {};
    const live = async () => {
      const r = await ctx.call('lease_renew', { lease_id: id, ttl_s: 300 }, opts);
      check(r.ok === true && r.data?.renewed === true && r.data.lease_id === id, 'build lease renewal failed');
      const state = await bState(ctx);
      check(state.building?.some((b) => b.owner === owner && b.label === label && b.expires_in_s > 0), 'live building state no longer names owner/label');
      return state;
    };
    const prompt = async (text, timeoutMs = 120_000) => { await live(); await ctx.human(text, { timeoutMs }); await live(); };
    await bWithCleanup(async () => {
      await bVetoMode(ctx, 1, opts);
      id = bGrant(await ctx.call('lease_acquire', { resources: ['asset:/Game/__HaybaTest__/B8'], mode: 'exclusive', ttl_s: 300, bind_connection: false, label, lane: 'long' }, opts), owner, false, held);
      await prompt(`Press Play once. Confirm refusal naming ${owner} and ${label}; leave PIE stopped.`, 120_000);
      check((await live()).pie === 'none', 'first user Play started PIE');
      await prompt('Press Play again within 10 s of the refused press. Leave PIE running.', 10_000);
      await bWait(ctx, 'second press user PIE', async () => (await live()).pie === 'user');
      await prompt('Stop PIE.');
      await bWait(ctx, 'PIE stopped', async () => (await live()).pie === 'none');
      await bVetoMode(ctx, 0, opts);
      await prompt(`In mode 0, Press Play once. Confirm notification naming ${owner} and ${label}; leave PIE running.`);
      await bWait(ctx, 'mode 0 user PIE running before Stop', async () => (await live()).pie === 'user');
      await prompt('Stop PIE.');
      await bWait(ctx, 'mode 0 PIE stopped', async () => (await live()).pie === 'none');
    }, [async () => { await bVetoMode(ctx, 1, opts); }, async () => { await bRelease((cmd, params) => ctx.call(cmd, params, opts), held); }]);
  } },
  { id: 'B9', title: 'global holder refuses named and anonymous scoped writes', run: async (ctx) => {
    const owner = bName('B9'); const caller = bName('B9-caller'); const opts = { owner }; const held = {};
    await bWithCleanup(async () => {
      bGrant(await ctx.call('lease_acquire', { resources: ['global'], mode: 'exclusive', ttl_s: 60, bind_connection: false }, opts), owner, undefined, held);
      bRefusal(await ctx.call('material_set_param', bParams, { owner: caller }), owner, caller);
      bRefusal(await ctx.call('material_set_param', bParams, { owner: null, lease: null }), owner);
    }, [async () => { await bRelease((cmd, params) => ctx.call(cmd, params, opts), held); }]);
  } },
  { id: 'B10', title: 'fifty fresh raw refusals and isolated ticker-only warning drain', run: async (ctx) => {
    const owner = bName('B10'); const opts = { owner }; const held = {};
    await bWithCleanup(async () => {
      bGrant(await ctx.call('lease_acquire', { resources: ['global'], mode: 'exclusive', ttl_s: 180, bind_connection: false }, opts), owner, undefined, held);
      const tail = bTail(ctx); const started = bNow(ctx); const callers = new Set(); const ids = new Set();
      for (let i = 1; i <= 50; i++) {
        // makeCtx.call -> once -> a new Conn for each request; no owner/lease envelope.
        const r = await ctx.call('material_set_param', bParams, { owner: null, lease: null });
        const d = bRefusal(r, owner);
        check(d.repeats_in_window === i, `call ${i}: repeats_in_window is ${d.repeats_in_window}`);
        check(typeof r.id === 'string' && !ids.has(r.id) && !callers.has(d.caller_owner), 'per-call correlation/connection identity repeated');
        ids.add(r.id); callers.add(d.caller_owner);
        check(bNow(ctx) - started < 30_000, 'fifty-call burst exceeded the single 30 s window');
      }
      const scoped = () => {
        const lines = tail.read().split(/\r?\n/);
        const first = lines.filter((l) => l.includes('Warning:') && l.includes('[enforced_for_writes]')
          && l.includes("owner_required: 'material_set_param' (write_scoped) names no owner") && l.includes(owner) && !/repeated \d+ more times/.test(l));
        const drained = lines.filter((l) => l.includes('Warning:') && l.includes('[enforced_for_writes] owner_required/owner_missing repeated ')
          && l.includes("owner='conn:*'") && l.includes("cmd='material_set_param'") && l.includes(`holder='${owner}'`));
        check(first.length <= 1, `expected one scoped first-hit Warning, found ${first.length}`);
        check(drained.length <= 1, `expected one scoped drain, found ${drained.length}`);
        if (drained.length) check(drained[0].includes('repeated 49 more times in 30 s:'), `incorrect scoped drain: ${drained[0]}`);
        return first.length === 1 && drained.length === 1;
      };
      // Only read the log while waiting: another conflicting call would force a drain.
      await bWait(ctx, 'the ticker-only scoped 49-hit drain', scoped, 65_000, 1_000);
    }, [async () => { await bRelease((cmd, params) => ctx.call(cmd, params, opts), held); }]);
  } },
];

// ----------------------------------------------------------------------------- Deploy C (C1-C3)

function cGrant(reply, owner, resource, label, bound, held) {
  held.label = label;
  held.resource = resource;
  held.owner = owner;
  // Capture the handle before validating the rest of the reply so cleanup can
  // still release a real grant if one of the later assertions fails.
  if (reply.ok === true && reply.data?.owner === owner && reply.data?.status === 'granted'
    && LEASE_ID_RE.test(reply.data?.lease_id ?? '')) held.lease_id = reply.data.lease_id;
  if (reply.ok === true && reply.data?.owner === owner && reply.data?.status === 'queued'
    && typeof reply.data.ticket === 'string' && reply.data.ticket) held.ticket = reply.data.ticket;
  const d = reply.data;
  check(reply.ok === true && d?.status === 'granted' && LEASE_ID_RE.test(d.lease_id ?? '')
    && d.owner === owner && d.bound_to_connection === bound && d.bind_connection === bound
    && Number.isFinite(d.expires_in_s) && d.expires_in_s > 0
    && d.resources?.length === 1 && d.resources[0]?.resource === resource
    && d.resources[0]?.mode === 'exclusive' && !('token' in d),
  `incorrect lease grant for ${resource}: ${JSON.stringify(reply)}`);
  return d.lease_id;
}

function cStatus(reply, owner) {
  check(reply.ok === true && reply.data?.caller_owner === owner
    && Array.isArray(reply.data.leases) && reply.data.enforcement === 'enforced_for_writes',
  `incorrect lease_status for ${owner}: ${JSON.stringify(reply)}`);
  return reply.data;
}

function cLease(status, held) {
  return status.leases.find((l) => l.owner === held.owner && l.label === held.label
    && l.resources?.length === 1 && l.resources[0]?.resource === held.resource
    && l.resources[0]?.mode === 'exclusive');
}

const C_STEPS = [
  { id: 'C1', title: 'lease_adopt persists on one socket, allows explicit override, and resets on reconnect', run: async (ctx) => {
    const owner = bName('C1'); const override = bName('C1-override');
    const resource = `asset:/Game/__HaybaTest__/${owner}`; const label = `adopt:${owner}`;
    const held = {}; let first; let second;
    await bWithCleanup(async () => {
      const g = await ctx.call('lease_acquire',
        { resources: [resource], ttl_s: 120, bind_connection: false, label }, { owner });
      const id = cGrant(g, owner, resource, label, false, held);
      first = await ctx.conn({ owner: null, lease: null });
      const before = await first.send('lease_status');
      check(before.ok === true && /^conn:\d+$/.test(before.data?.caller_owner ?? '')
        && before.data?.connection_owner === '', `C1 fresh caller: ${JSON.stringify(before)}`);
      const synthetic = before.data.caller_owner;
      const adopt = async (connection) => {
        const r = await connection.send('lease_adopt', { owner, lease_id: id }, { owner: null, lease: null });
        check(r.ok === true && r.data?.adopted === true && r.data.owner === owner
          && r.data.lease_id === id && r.data.connection_owner === owner
          && Number.isFinite(r.data.expires_in_s) && r.data.expires_in_s > 0,
        `C1 adoption: ${JSON.stringify(r)}`);
      };
      await adopt(first);
      await adopt(first); // Repeating the same adoption is idempotent.
      const after = await first.send('lease_status');
      check(after.ok === true && after.data?.caller_owner === owner
        && after.data.connection_owner === owner, `C1 adopted status: ${JSON.stringify(after)}`);
      const explicit = await first.send('lease_status', {}, { owner: override, lease: null });
      check(explicit.ok === true && explicit.data?.caller_owner === override
        && explicit.data.connection_owner === owner, `C1 explicit override: ${JSON.stringify(explicit)}`);
      const reverted = await first.send('lease_status');
      check(reverted.ok === true && reverted.data?.caller_owner === owner
        && reverted.data.connection_owner === owner, `C1 override persisted: ${JSON.stringify(reverted)}`);
      first.close(); first = null;
      second = await ctx.conn({ owner: null, lease: null });
      const fresh = await second.send('lease_status');
      check(fresh.ok === true && /^conn:\d+$/.test(fresh.data?.caller_owner ?? '')
        && fresh.data.caller_owner !== synthetic && fresh.data.connection_owner === '',
      `C1 reconnect retained adoption: ${JSON.stringify(fresh)}`);
      await adopt(second);
      const again = await second.send('lease_status');
      check(again.ok === true && again.data?.caller_owner === owner
        && again.data.connection_owner === owner, `C1 re-adopt status: ${JSON.stringify(again)}`);
    }, [
      () => { first?.close(); second?.close(); },
      async () => { await bRelease((cmd, params) => ctx.call(cmd, params, { owner }), held); },
    ]);
  } },
  { id: 'C2', title: 'another socket cannot claim a reserved synthetic owner or local', run: async (ctx) => {
    let holder; let claimant;
    await bWithCleanup(async () => {
      holder = await ctx.conn({ owner: null, lease: null });
      claimant = await ctx.conn({ owner: null, lease: null });
      const h = await holder.send('lease_status');
      const q = await claimant.send('lease_status');
      check(h.ok === true && q.ok === true && /^conn:\d+$/.test(h.data?.caller_owner ?? '')
        && /^conn:\d+$/.test(q.data?.caller_owner ?? '')
        && h.data.caller_owner !== q.data.caller_owner, 'C2 needs two distinct synthetic callers');
      const mine = h.data.caller_owner; const theirs = q.data.caller_owner;
      for (const claimed of [mine, 'local']) {
        const r = await claimant.send('ping', {}, { owner: claimed, lease: null });
        check(r.ok === false && r.code === 'owner_reserved'
          && r.owner?.claimed_owner === claimed && r.owner?.caller_owner === theirs
          && r.owner?.conn === Number(theirs.slice('conn:'.length))
          && r.advisory?.state === 'input_rejected'
          && r.advisory?.mutation_status === 'not_started',
        `C2 reserved-owner refusal for ${claimed}: ${JSON.stringify(r)}`);
      }
      const self = await holder.send('ping', {}, { owner: mine, lease: null });
      check(self.ok === true, `C2 own synthetic owner refused: ${JSON.stringify(self)}`);
    }, [() => { claimant?.close(); holder?.close(); }]);
  } },
  { id: 'C3', title: 'a conn-owned batch records an orphaned sentinel in a step after socket close', run: async (ctx) => {
    const watcher = bName('C3-watch'); const name = bName('C3');
    const batchHeld = {}; const sentinelHeld = {};
    let socket; let caller; let job; let acceptedUnknown = false; let terminal = false;
    const watch = async () => cStatus(await ctx.call('lease_status', {}, { owner: watcher }), watcher);
    await bWithCleanup(async () => {
      const ping = await ctx.call('ping', {}, { owner: watcher });
      check(ping.ok === true, `C3 watcher not present: ${JSON.stringify(ping)}`);
      const state = await ctx.call('editor_get_state', { include_dirty: false });
      check(state.ok === true && state.data?.pie === 'none' && state.data.editor_unsafe === false,
        `C3 scratch host not safe for a batch: ${JSON.stringify(state)}`);
      socket = await ctx.conn({ owner: null, lease: null });
      const initial = await socket.send('lease_status');
      check(initial.ok === true && /^conn:\d+$/.test(initial.data?.caller_owner ?? '')
        && initial.data?.connection_owner === '' && initial.data?.enforcement === 'enforced_for_writes',
      `C3 anonymous status: ${JSON.stringify(initial)}`);
      caller = initial.data.caller_owner;
      const acquire = async (suffix, bound, held) => {
        const resource = `asset:/Game/__HaybaTest__/${name}_${suffix}`;
        const label = `${suffix}:${name}`;
        const g = await socket.send('lease_acquire', {
          resources: [resource], ttl_s: 60, bind_connection: bound, label,
        }, { owner: null, lease: null });
        return cGrant(g, caller, resource, label, bound, held);
      };
      const batchId = await acquire('batch', false, batchHeld);
      const sentinelId = await acquire('sentinel', true, sentinelHeld);
      check(batchId !== sentinelId, 'C3 leases share one handle');
      const own = cStatus(await socket.send('lease_status'), caller);
      for (const held of [batchHeld, sentinelHeld]) {
        const item = cLease(own, held);
        check(item?.mine === true && item.lease_id === held.lease_id
          && item.orphaned === false && item.bound_to_connection === (held === sentinelHeld)
          && Number.isFinite(item.expires_in_s) && item.expires_in_s > 0,
        `C3 owned lease missing before close: ${JSON.stringify(item)}`);
      }
      const params = {
        lease_id: batchId, idle_ticks: 120, fence_timeout_s: 30,
        steps: [
          { cmd: 'ping', fence_after: 'idle' },
          { cmd: 'ping', fence_after: 'none' },
          { cmd: 'lease_status', fence_after: 'none' },
        ],
      };
      const anonymous = await socket.send('editor_batch', params, { owner: null, lease: null });
      if (anonymous.ok === true && anonymous.data?.job_id) job = anonymous.data.job_id;
      if (anonymous.ok === true && !job) acceptedUnknown = true;
      check(anonymous.ok === false && anonymous.code === 'owner_required'
        && anonymous.lease?.command === 'editor_batch' && anonymous.lease?.caller_owner === caller
        && anonymous.lease?.enforcement === 'enforced_for_writes'
        && anonymous.lease?.reason === 'owner_missing' && !anonymous.data?.job_id,
      `C3 unidentified batch did not refuse: ${JSON.stringify(anonymous)}`);
      const accepted = await socket.send('editor_batch', params, { owner: null, lease: batchId });
      if (accepted.ok === true && typeof accepted.data?.job_id === 'string' && accepted.data.job_id) job = accepted.data.job_id;
      if (accepted.ok === true && !job) {
        acceptedUnknown = true;
        (ctx.retainedFixtures ??= []).push({ step: 'C3', owner: caller,
          labels: [batchHeld.label, sentinelHeld.label], reason: 'batch accepted without a job id; controlled scratch recovery required' });
        throw new Error('C3 batch accepted without a job id; controlled scratch recovery required');
      }
      // Native may accept then a later assertion fail. Preserve the job for recovery.
      check(accepted.ok === true && accepted.data?.command === 'editor_batch'
        && accepted.data?.status === 'running' && job && accepted.data.owner === caller
        && accepted.data.steps_total === 3,
      `C3 batch acceptance: ${JSON.stringify(accepted)}`);
      socket.close(); socket = null;
      const done = await bWait(ctx, 'C3 batch terminal status', async () => {
        const r = await ctx.call('batch_status', { job_id: job }, { owner: watcher });
        check(r.ok === true && r.data?.job_id === job && r.data?.owner === caller
          && r.data.command === 'editor_batch' && r.data.steps_total === 3
          && ['running', 'succeeded', 'failed'].includes(r.data.status),
        `C3 batch status mismatch: ${JSON.stringify(r)}`);
        return r.data.status === 'running' ? null : r.data;
      }, 60_000, 250);
      terminal = true;
      check(done.status === 'succeeded' && done.steps_run === 3 && done.steps?.length === 3,
        `C3 batch incomplete: ${JSON.stringify(done)}`);
      for (const [i, command] of ['ping', 'ping', 'lease_status'].entries()) {
        const step = done.steps[i];
        check(step?.index === i && step.cmd === command && step.state === 'ok'
          && step.fence_after === (i === 0 ? 'idle' : 'none')
          && !step.data_truncated && !('data_text' in step) && step.data && typeof step.data === 'object',
        `C3 step ${i} is not an exact parsed result: ${JSON.stringify(step)}`);
        if (i < 2) check(step.data.capabilities?.lease_id === true,
          `C3 ping step ${i} lacks lease capability`);
      }
      const witness = done.steps[2].data;
      const sentinel = cLease(witness, sentinelHeld);
      check(witness.caller_owner === caller && witness.connection_owner === ''
        && sentinel?.mine === true && sentinel.lease_id === sentinelId
        && sentinel.orphaned === true && sentinel.bound_to_connection === false
        && sentinel.bind_connection === true
        && Number.isFinite(sentinel.expires_in_s) && sentinel.expires_in_s > 0,
      `C3 final step did not record an orphan after native close: ${JSON.stringify(witness)}`);
      // A watcher must only see foreign status, with no exposed lease ids.
      const foreign = await watch();
      for (const held of [batchHeld, sentinelHeld]) {
        const item = cLease(foreign, held);
        if (item) check(item.mine === false && !('lease_id' in item),
          `C3 watcher can see a foreign handle: ${JSON.stringify(item)}`);
      }
    }, [
      async () => {
        if (socket && !socket.closed && !job && !acceptedUnknown) await bRelease(socket.send.bind(socket), sentinelHeld);
      },
      async () => {
        if (socket && !socket.closed && !job && !acceptedUnknown) await bRelease(socket.send.bind(socket), batchHeld);
      },
      () => socket?.close(),
      async () => {
        if (!batchHeld.lease_id && !sentinelHeld.lease_id) return;
        if (acceptedUnknown || (job && !terminal)) {
          (ctx.retainedFixtures ??= []).push({ step: 'C3', owner: caller, job_id: job,
            labels: [batchHeld.label, sentinelHeld.label], reason: 'batch terminal state unconfirmed; controlled scratch recovery required' });
          throw new Error(`C3 job ${job ?? '<missing-id>'} may still be running; controlled scratch recovery required`);
        }
        await bWait(ctx, 'both C3 leases expire naturally', async () => {
          const status = await watch();
          return !cLease(status, batchHeld) && !cLease(status, sentinelHeld);
        }, 120_000, 1_000);
      },
    ]);
  } },
];

export const STEPS = { a: A_STEPS, b: B_STEPS, c: C_STEPS };

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
