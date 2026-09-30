#!/usr/bin/env node
// Live probe for Blueprint event authoring: bound events (UMG clicks), custom
// events, override events, sequence/self/create_widget nodes, function
// signatures, typed variables, node removal and function libraries.
//
// It talks straight to the plugin's TCP port, so it proves the C++ side with no
// MCP server in the loop. Run it before Live Coding and it fails on "unknown
// command"; run it after and every check must pass. A reply is a claim — each
// check reads back the effect (pins, readback flags, compile result, files on
// disk) rather than trusting `ok`.
//
// Everything it creates lives under /Game/HaybaMCPAutomation/<run id> and is
// deleted at the end; --keep leaves it for inspection. With --project the port
// is discovered from Saved/HaybaMCP/instances and deletion is confirmed on disk.
//
//   node scripts/probe-blueprint-authoring.mjs --project <project>
//   HAYBA_UE_PROJECT=<project> node scripts/probe-blueprint-authoring.mjs
//   node scripts/probe-blueprint-authoring.mjs --port 52342 --keep

import net from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { keep: false, project: process.env.HAYBA_UE_PROJECT || undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--project') out.project = argv[++i];
  }
  return out;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

/** The newest registry entry whose editor is still running. Editors that exit
 *  without cleaning up leave their file behind, so the folder fills with dead
 *  entries — 50 of them in one project — and the first file is usually stale. */
function discoverPort(project) {
  if (!project) return undefined;
  const dir = join(project, 'Saved', 'HaybaMCP', 'instances');
  if (!existsSync(dir)) return undefined;
  const live = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (Number.isInteger(entry.port) && Number.isInteger(entry.pid) && isAlive(entry.pid)) live.push(entry);
    } catch {
      // A half-written registry file is not a port.
    }
  }
  live.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return live[0]?.port;
}

class Wire {
  constructor(port) {
    this.port = port;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.counter = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: '127.0.0.1', port: this.port }, resolve);
      this.socket.once('error', reject);
      this.socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(4 + length);
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter(message);
      }
    }
  }

  send(cmd, params = {}, timeoutMs = 60_000) {
    const id = `probe_${++this.counter}`;
    const payload = Buffer.from(JSON.stringify({ cmd, id, params }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `timeout after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.socket.write(Buffer.concat([header, payload]));
    });
  }

  close() {
    this.socket?.end();
  }
}

let failed = 0;
let passed = 0;

function check(name, condition, reply) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    const detail = reply ? JSON.stringify(reply).slice(0, 600) : '';
    console.log(`  FAIL  ${name}\n        ${detail}`);
  }
  return condition;
}

/** Fixture steps are not the thing under test; if one fails, stop rather than
 *  report a cascade of failures that only restate it. */
function must(name, reply) {
  if (!reply.ok) throw new Error(`fixture step failed: ${name}: ${reply.error ?? JSON.stringify(reply)}`);
  return reply;
}

const pinNames = (reply) => (reply.data?.pins ?? []).map((p) => p.name);
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

async function main() {
  const port = args.port ?? discoverPort(args.project) ?? 52342;
  const wire = new Wire(port);
  try {
    await wire.connect();
  } catch (err) {
    console.error(`probe-blueprint-authoring: no plugin listening on 127.0.0.1:${port} (${err.code}). Is the editor running?`);
    process.exit(2);
  }
  console.log(`probe-blueprint-authoring: plugin on 127.0.0.1:${port}`);

  const dir = `/Game/HaybaMCPAutomation/BEA_${Date.now().toString(36)}`;
  const wbpName = 'WBP_BeaProbe';
  const wbp = `${dir}/${wbpName}`;
  const bflName = 'BFL_BeaProbe';
  const bfl = `${dir}/${bflName}`;
  const created = [];

  try {
    // Fixture: a widget with one button exposed as a variable.
    must('create probe widget', await wire.send('ui_create_widget', { path: dir, name: wbpName }));
    created.push(`${wbp}.${wbpName}`);
    must('build probe tree', await wire.send('ui_build_tree', {
      widget_blueprint_path: wbp,
      tree: { class: 'CanvasPanel', name: 'ProbeRoot', children: [{ class: 'Button', name: 'ProbeButton' }] },
    }));
    must('expose the button', await wire.send('ui_set_variable', { widget_blueprint_path: wbp, widget_name: 'ProbeButton', is_variable: true }));
    must('compile probe widget', await wire.send('ui_compile_widget', { widget_blueprint_path: wbp, save_on_success: true }));

    console.log('bound events (UMG clicks)');
    let r = await wire.send('blueprint_add_bound_event', { path: wbp, target: 'ProbeButton', event_name: 'OnClicked' });
    check('binds ProbeButton.OnClicked', r.ok && r.data?.verified === true && typeof r.data?.node_id === 'string' && pinNames(r).includes('then'), r);
    const clickId = r.data?.node_id;
    r = await wire.send('blueprint_add_bound_event', { path: wbp, target: 'ProbeButton', event_name: 'OnClicked' });
    check('binding again returns the same node', r.ok && r.data?.already_existed === true && r.data?.node_id === clickId, r);
    r = await wire.send('blueprint_add_bound_event', { path: wbp, target: 'ProbeButton', event_name: 'OnClik' });
    check('a misspelt event is refused, naming the real ones', !r.ok && /OnClicked/.test(r.error ?? ''), r);
    r = await wire.send('blueprint_add_bound_event', { path: wbp, target: 'NoSuchWidget', event_name: 'OnClicked' });
    check('an unknown widget is refused with the is-variable hint', !r.ok && /ui_set_variable/.test(r.error ?? ''), r);

    console.log('custom events');
    r = await wire.send('blueprint_add_custom_event', { path: wbp, event_name: 'ProbeStep', inputs: [{ name: 'Amount', type: 'float' }] });
    check('custom event carries its typed input and delegate pin', r.ok && r.data?.verified === true && pinNames(r).includes('Amount') && pinNames(r).includes('OutputDelegate'), r);
    r = await wire.send('blueprint_add_custom_event', { path: wbp, event_name: 'probestep' });
    check('a second event with the same name is refused', !r.ok && /ProbeStep/i.test(r.error ?? ''), r);

    console.log('node kinds');
    r = await wire.send('blueprint_add_node', { path: wbp, node_type: 'sequence', option_count: 3 });
    const seqId = r.data?.node_id;
    check('sequence has three outputs', r.ok && ['then_0', 'then_1', 'then_2'].every((p) => pinNames(r).includes(p)), r);
    r = await wire.send('blueprint_add_node', { path: wbp, node_type: 'self' });
    const selfId = r.data?.node_id;
    check('self node', r.ok && pinNames(r).includes('self'), r);
    r = await wire.send('blueprint_add_node', { path: wbp, node_type: 'create_widget', class_path: `${wbp}.${wbpName}_C` });
    check('create_widget is typed to the widget class', r.ok && pinNames(r).includes('ReturnValue') && String(r.data?.return_class ?? '').endsWith(`${wbpName}_C`), r);
    r = await wire.send('blueprint_connect_nodes', { path: wbp, from_node: clickId, from_pin: 'then', to_node: seqId, to_pin: 'execute' });
    check('the click drives the sequence', r.ok && r.data?.verified === true, r);

    console.log('override events');
    r = await wire.send('blueprint_add_event', { path: wbp, event_name: 'Event Construct' });
    check('Construct resolves from its node title', r.ok && typeof r.data?.node_id === 'string', r);

    console.log('function signatures');
    r = await wire.send('blueprint_add_function', {
      path: wbp, function_name: 'ProbeScale', pure: true,
      inputs: [{ name: 'Value', type: 'float' }, { name: 'Lines', type: 'array<text>' }],
      outputs: [{ name: 'Result', type: 'float' }],
    });
    check('function compiles with its signature', r.ok && r.data?.compiled_clean === true && r.data?.verified === true, r);
    const sig = r.data?.signature;
    check('reports the parameters the compiled function really has',
      sameSet(sig?.inputs?.map((p) => p.name), ['Value', 'Lines']) && sameSet(sig?.outputs?.map((p) => p.name), ['Result']) && sig?.pure === true, r);
    const entryId = r.data?.entry_node_id;
    check('hands back the entry and result nodes to wire', typeof entryId === 'string' && typeof r.data?.result_node_id === 'string', r);
    r = await wire.send('blueprint_add_function', { path: wbp, function_name: 'ProbeBad', inputs: [{ name: 'X', type: 'vector3' }] });
    check('a bad parameter type refuses the whole function', !r.ok && /vector3/.test(r.error ?? ''), r);
    r = await wire.send('blueprint_get_info', { path: wbp });
    check('and leaves no half-made graph behind', r.ok && !(r.data?.functions ?? []).includes('ProbeBad'), r);

    console.log('typed variables');
    for (const [name, type, value] of [
      ['ProbeRef', 'object:/Script/UMG.Button'],
      ['ProbeLines', 'array<text>'],
      ['ProbeRate', 'float', '0.2'],
      ['ProbeWhere', 'vector'],
    ]) {
      r = await wire.send('blueprint_add_variable', { path: wbp, variable_name: name, variable_type: type, ...(value ? { default_value: value } : {}) });
      // The stored default is the CDO's own text form ("0.200000" for 0.2), so a
      // numeric default is compared as a number, not as the string that was sent.
      const storedMatches = value === undefined
        || (r.data?.default_value !== undefined && Number(r.data.default_value) === Number(value));
      check(`variable ${name}: ${type}${value ? ` = ${value}` : ''}`,
        r.ok && r.data?.verified === true && r.data?.compiled_clean === true && storedMatches, r);
    }

    console.log('removal');
    r = await wire.send('blueprint_remove_node', { path: wbp, node_id: selfId });
    check('removes the self node', r.ok && r.data?.verified === true, r);
    r = await wire.send('blueprint_remove_node', { path: wbp, graph_name: 'ProbeScale', node_id: entryId });
    check('refuses to remove a function entry node', !r.ok && /entry/i.test(r.error ?? ''), r);

    console.log('compile');
    r = await wire.send('blueprint_compile', { path: wbp, save: true });
    check('the probe widget compiles with no errors', r.ok && r.data?.ok === true && r.data?.error_count === 0, r);

    console.log('function libraries');
    r = await wire.send('blueprint_create', { name: bflName, package_path: bfl, parent_class_path: '/Script/Engine.BlueprintFunctionLibrary' });
    if (r.ok) created.push(`${bfl}.${bflName}`);
    check('is a real function library', r.ok && r.data?.blueprint_type === 'function_library', r);
    r = await wire.send('blueprint_add_function', {
      path: bfl, function_name: 'ProbeDouble', pure: true,
      inputs: [{ name: 'In', type: 'float' }], outputs: [{ name: 'Out', type: 'float' }],
    });
    check('library function compiles', r.ok && r.data?.compiled_clean === true, r);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${err.message}`);
  } finally {
    if (!args.keep && created.length > 0) {
      const r = await wire.send('asset_delete', { paths: created });
      if (args.project) {
        // The registry has lied about deletes before; the filesystem decides.
        const left = created.filter((p) => existsSync(join(args.project, 'Content', `${p.split('.')[0].replace(/^\/Game\//, '')}.uasset`)));
        check('probe assets are gone from disk', left.length === 0, left.length ? { left, reply: r } : undefined);
      } else {
        check('probe assets deleted (not verified on disk: no --project)', r.ok, r);
      }
    }
    wire.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
