import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  makePyToolHandler,
  toToolDescriptor,
  registerPyTool,
  type PyToolDescriptor,
} from './py-tool-factory.js';
import { setDefaultSender, type Sender } from './tool-executor.js';
import { deriveSignature } from './schema-registry.js';
import { getToolMeta, resetToolMetaRegistry } from './tool-meta-registry.js';
import type { SessionManager } from './types.js';

// Mirror ue-python.test.ts: a sender whose canned stdout drives the parse path.
function mockStdout(stdout: string, stderr = ''): Sender {
  return async () => ({ id: 'inmem', ok: true, data: { ok: true, stdout, stderr } });
}

// A representative descriptor: one required string param + one defaulted number.
const sampleDescriptor: PyToolDescriptor<{
  target: z.ZodString;
  limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}> = {
  name: 'demo_py_tool',
  description: 'A demo python-backed tool.',
  cost: 'low',
  returns: '{ok, echoed}',
  schema: {
    target: z.string().min(1).describe('Thing to act on'),
    limit: z.number().int().optional().default(5).describe('Cap'),
  },
  buildScript: (p) => `_emit({"ok": True, "target": ${JSON.stringify(p.target)}, "limit": ${p.limit}})`,
};

describe('makePyToolHandler', () => {
  beforeEach(() => setDefaultSender(undefined as never));

  it('returns a clean error on invalid params (and never dispatches)', async () => {
    let dispatched = false;
    setDefaultSender((async () => { dispatched = true; return { id: 'x', ok: true, data: {} }; }) as Sender);
    const handler = makePyToolHandler(sampleDescriptor);

    // `target` is required; omit it.
    const res = await handler({ limit: 2 });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Invalid params for demo_py_tool');
    expect(dispatched).toBe(false);
  });

  it('runs buildScript with parsed/defaulted params and returns the HAYBA_JSON result', async () => {
    setDefaultSender(mockStdout('noise\nHAYBA_JSON:{"ok":true,"target":"rock","limit":5}\ntrailing'));
    const handler = makePyToolHandler(sampleDescriptor);

    // `limit` omitted → zod default (5) must reach buildScript.
    const res = await handler({ target: 'rock' });

    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toEqual({ ok: true, target: 'rock', limit: 5 });
  });

  it('passes the validated params into buildScript (default applied)', async () => {
    let seen: unknown;
    const d: PyToolDescriptor<{ target: z.ZodString; limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>> }> = {
      ...sampleDescriptor,
      buildScript: (p) => { seen = p; return '_emit({"ok": True})'; },
    };
    setDefaultSender(mockStdout('HAYBA_JSON:{"ok":true}'));
    await makePyToolHandler(d)({ target: 'tree' });
    expect(seen).toEqual({ target: 'tree', limit: 5 });
  });

  it('errors cleanly when the HAYBA_JSON marker is missing', async () => {
    setDefaultSender(mockStdout('python ran but emitted nothing useful'));
    const handler = makePyToolHandler(sampleDescriptor);

    const res = await handler({ target: 'rock' });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('demo_py_tool error');
    expect(parsed.error).toContain('no HAYBA_JSON');
  });

  it('forwards timeoutMs to the sender', async () => {
    let seenTimeout = -1;
    setDefaultSender((async (_c, _p, t) => {
      seenTimeout = t;
      return { id: 'x', ok: true, data: { ok: true, stdout: 'HAYBA_JSON:{"ok":true}' } };
    }) as Sender);
    await makePyToolHandler({ ...sampleDescriptor, timeoutMs: 45_000 })({ target: 'rock' });
    expect(seenTimeout).toBe(45_000);
  });
});

describe('toToolDescriptor', () => {
  it('adapts a PyToolDescriptor to the canonical ToolDescriptor shape', () => {
    const td = toToolDescriptor(sampleDescriptor);
    expect(td.name).toBe('demo_py_tool');
    expect(td.cost).toBe('low');
    expect(td.returns).toBe('{ok, echoed}');
    expect(td.schema).toBe(sampleDescriptor.schema);
    expect(typeof td.handler).toBe('function');
  });

  it('synthesizes a minimal meta from cost when none is supplied', () => {
    const td = toToolDescriptor(sampleDescriptor);
    expect(td.meta.cost).toBe('low');
    expect(td.meta.effects).toEqual([]);
  });

  it('preserves a supplied meta verbatim', () => {
    const meta = { cost: 'low' as const, effects: ['mutates_asset'], when: 'w', not_when: 'nw' };
    const td = toToolDescriptor({ ...sampleDescriptor, meta });
    expect(td.meta).toBe(meta);
  });
});

describe('registerPyTool', () => {
  beforeEach(() => {
    resetToolMetaRegistry();
    setDefaultSender(undefined as never);
  });

  // Minimal fake McpServer that records the server.tool(...) call. registerTool
  // only touches server.tool, so this is sufficient to exercise registration.
  function fakeServer() {
    const calls: Array<{ name: string; description: string; schema: unknown; handler: (p: Record<string, unknown>) => Promise<unknown> }> = [];
    const server = {
      tool: (name: string, description: string, schema: unknown, handler: (p: Record<string, unknown>) => Promise<unknown>) => {
        calls.push({ name, description, schema, handler });
      },
    } as unknown as McpServer;
    return { server, calls };
  }

  const session = {} as SessionManager;

  it('records the schema so get_tool_signature can derive it', () => {
    const { server } = fakeServer();
    registerPyTool(server, session, { ...sampleDescriptor, name: 'reg_sig_tool' });

    const sig = deriveSignature('reg_sig_tool');
    expect(sig).not.toBeNull();
    expect(sig!.cost).toBe('low');
    expect(sig!.returns).toBe('{ok, echoed}');
    expect(sig!.params.target).toContain('string');
    expect(sig!.params.target).toContain('(required)');
    expect(sig!.params.limit).toContain('(optional)'); // defaulted ⇒ optional
  });

  it('registers tool meta for cost lookup', () => {
    const { server } = fakeServer();
    registerPyTool(server, session, { ...sampleDescriptor, name: 'reg_meta_tool' });
    expect(getToolMeta('reg_meta_tool')?.cost).toBe('low');
  });

  it('calls server.tool with the appendMeta-decorated description + schema', () => {
    const { server, calls } = fakeServer();
    registerPyTool(server, session, { ...sampleDescriptor, name: 'reg_server_tool' });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('reg_server_tool');
    expect(calls[0].description).toContain('A demo python-backed tool.');
    expect(calls[0].description).toContain('[cost=low]'); // appendMeta block present
    expect(calls[0].schema).toBe(sampleDescriptor.schema);
  });

  it('the registered handler runs the python and returns the parsed result', async () => {
    const { calls } = fakeServer();
    const srv = { tool: (n: string, d: string, s: unknown, h: (p: Record<string, unknown>) => Promise<unknown>) => calls.push({ name: n, description: d, schema: s, handler: h }) } as unknown as McpServer;
    registerPyTool(srv, session, { ...sampleDescriptor, name: 'reg_handler_tool' });

    setDefaultSender(mockStdout('HAYBA_JSON:{"ok":true,"target":"x","limit":5}'));
    const result = await calls[0].handler({ target: 'x' }) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, target: 'x', limit: 5 });
  });
});
