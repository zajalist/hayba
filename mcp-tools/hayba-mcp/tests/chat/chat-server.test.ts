import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  registerChatRoutes,
  __resetChatState,
  __sweepSessions,
  __sessionCount,
  isLoopback,
} from '../../src/chat/chat-server.js';
import type { LLMClient, LLMStreamEvent } from '../../src/agents/llm-client.js';

// A distinctive fake key we assert never leaks into any SSE frame or config read.
const FAKE_KEY = 'sk-ant-LEAK-CANARY-000111222333';

// ---------------------------------------------------------------------------
// Scriptable fake LLM client
// ---------------------------------------------------------------------------

interface ScriptStep {
  deltas?: string[];
  slowMs?: number;
  content: string | null;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

function makeFakeClientFactory(script: ScriptStep[]): () => LLMClient {
  let turn = 0;
  return () =>
    ({
      provider: 'mock',
      model: 'fake',
      protocol: 'anthropic',
      async complete() {
        throw new Error('not used');
      },
      async *stream(): AsyncGenerator<LLMStreamEvent, void, unknown> {
        const step = script[turn++] ?? {
          content: null,
          toolCalls: [],
          stopReason: 'end_turn' as const,
        };
        for (const t of step.deltas ?? []) {
          if (step.slowMs) await new Promise((r) => setTimeout(r, step.slowMs));
          yield { type: 'text_delta', text: t };
        }
        yield {
          type: 'done',
          response: {
            content: step.content,
            toolCalls: step.toolCalls,
            stopReason: step.stopReason,
          },
        };
      },
    }) as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// SSE reader — parses `event:`/`data:`/`id:` frames from a fetch stream.
// ---------------------------------------------------------------------------

interface Frame {
  id?: number;
  event: string;
  data: unknown;
}

async function readAllFrames(body: ReadableStream<Uint8Array>): Promise<Frame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Frame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = drain(buf, frames);
  }
  drain(buf + '\n\n', frames);
  return frames;
}

function drain(buf: string, out: Frame[]): string {
  let idx: number;
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    if (!block.trim() || block.startsWith(':')) continue; // heartbeat / blank
    let event = 'message';
    let dataStr = '';
    let id: number | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    }
    let data: unknown = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {
      /* leave as string */
    }
    out.push({ id, event, data });
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function startApp(opts: Parameters<typeof registerChatRoutes>[1]): {
  server: Server;
  url: string;
} {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, opts);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('sidecar SSE chat server', () => {
  let server: Server;
  let url: string;

  beforeEach(() => __resetChatState());
  afterEach(() => server?.close());

  it('isLoopback recognises loopback addresses only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it('streams ordered SSE frames: tool_call → tool_result → text_delta → done', async () => {
    let dispatchCount = 0;
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        {
          content: null,
          toolCalls: [{ id: 't1', name: 'get_thing', input: { q: 1 } }],
          stopReason: 'tool_use',
        },
        { deltas: ['Hello ', 'world'], content: 'Hello world', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [
        { name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } },
      ],
      dispatchTool: async () => {
        dispatchCount++;
        return { ok: true, value: 42 };
      },
    }));

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's1', prompt: 'hi', provider: 'mock' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readAllFrames(res.body!);
    const events = frames.map((f) => f.event);

    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
    expect(events).toContain('text_delta');
    expect(events[events.length - 1]).toBe('done');
    // ordering: tool_call before tool_result before first text_delta
    expect(events.indexOf('tool_call')).toBeLessThan(events.indexOf('tool_result'));
    expect(events.indexOf('tool_result')).toBeLessThan(events.indexOf('text_delta'));

    const done = frames.find((f) => f.event === 'done')!.data as {
      reason: string;
      assistant_text: string;
      tool_trace: Array<{ name: string; result: unknown }>;
    };
    expect(done.reason).toBe('end_turn');
    expect(done.assistant_text).toBe('Hello world');
    expect(done.tool_trace[0].name).toBe('get_thing');
    expect(done.tool_trace[0].result).toEqual({ ok: true, value: 42 });
    expect(dispatchCount).toBe(1);

    // seq ids are monotonic
    const ids = frames.map((f) => f.id!).filter((n) => Number.isFinite(n));
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
  });

  it('cancel mid-stream ends with done{cancelled:true, partial_text}', async () => {
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        {
          deltas: ['a', 'b', 'c', 'd', 'e'],
          slowMs: 25,
          content: 'abcde',
          toolCalls: [],
          stopReason: 'end_turn',
        },
      ]) as never,
      dispatchTool: async () => ({}),
    }));

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cx', prompt: 'go', provider: 'mock' }),
    });

    // Read in the background; fire cancel once some text has arrived.
    const framesP = readAllFrames(res.body!);
    await new Promise((r) => setTimeout(r, 40));
    const cancelRes = await fetch(`${url}/chat/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cx' }),
    });
    expect((await cancelRes.json()).cancelled).toBe(true);

    const frames = await framesP;
    const done = frames.find((f) => f.event === 'done')!.data as {
      cancelled: boolean;
      partial_text: string;
    };
    expect(done.cancelled).toBe(true);
    expect(done.partial_text.length).toBeGreaterThan(0);
    expect(done.partial_text.length).toBeLessThan('abcde'.length);
  });

  it('resume replays buffered frames without re-dispatching tools', async () => {
    let dispatchCount = 0;
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        {
          content: null,
          toolCalls: [{ id: 'r1', name: 'get_thing', input: {} }],
          stopReason: 'tool_use',
        },
        { deltas: ['done'], content: 'done', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [
        { name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } },
      ],
      dispatchTool: async () => {
        dispatchCount++;
        return { ok: true };
      },
    }));

    // First turn: run to completion (frames buffer server-side).
    const first = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'rs', prompt: 'x', provider: 'mock' }),
    });
    const firstFrames = await readAllFrames(first.body!);
    expect(dispatchCount).toBe(1);
    expect(firstFrames.at(-1)!.event).toBe('done');

    // Reconnect with last_seq=0 → replay ALL buffered frames, no new dispatch.
    const resume = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'rs', last_seq: 0 }),
    });
    const replayed = await readAllFrames(resume.body!);
    expect(dispatchCount).toBe(1); // NOT re-dispatched
    expect(replayed.map((f) => f.event)).toEqual(firstFrames.map((f) => f.event));
  });

  it('config: set → masked get; raw key never returned', async () => {
    ({ server, url } = startApp({}));
    const setRes = await fetch(`${url}/chat/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'cfg', provider: 'anthropic', api_key: FAKE_KEY }),
    });
    const setBody = await setRes.text();
    expect(setBody).not.toContain(FAKE_KEY);
    expect(JSON.parse(setBody).key_last4).toBe('2333');

    const getRes = await fetch(`${url}/chat/config?session_id=cfg`);
    const getBody = await getRes.text();
    expect(getBody).not.toContain(FAKE_KEY);
    const parsed = JSON.parse(getBody);
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.key_last4).toBe('2333');
  });

  it('I3: a concurrent second /chat/stream gets a real 409 (not mid-stream JSON)', async () => {
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { deltas: ['a', 'b', 'c'], slowMs: 50, content: 'abc', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      dispatchTool: async () => ({}),
    }));

    const first = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'conc', prompt: 'go', provider: 'mock' }),
    });
    const firstP = readAllFrames(first.body!);
    await new Promise((r) => setTimeout(r, 20)); // let the first turn start running

    const second = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'conc', prompt: 'again', provider: 'mock' }),
    });
    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/json');
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/in flight/);

    await firstP; // drain the first stream
  });

  it('I2: resume past the eviction window emits an explicit resume_gap error', async () => {
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        // 600 deltas overflow BUFFER_LIMIT (500) so the buffer head advances.
        { deltas: Array(600).fill('.'), content: '.'.repeat(600), toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      dispatchTool: async () => ({}),
    }));

    const first = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'gap', prompt: 'x', provider: 'mock' }),
    });
    await readAllFrames(first.body!); // run to completion; early frames get evicted

    const resume = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'gap', last_seq: 5 }), // predates buffer head
    });
    const frames = await readAllFrames(resume.body!);
    const err = frames.find((f) => f.event === 'error')!.data as {
      code: string;
      oldest_available_seq: number;
    };
    expect(err.code).toBe('resume_gap');
    expect(err.oldest_available_seq).toBeGreaterThan(6);
  });

  it('I1: idle session evicted by the TTL sweep; active controller aborted', async () => {
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { deltas: ['a', 'b', 'c', 'd'], slowMs: 60, content: 'abcd', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      dispatchTool: async () => ({}),
    }));

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'idle', prompt: 'go', provider: 'mock' }),
    });
    const framesP = readAllFrames(res.body!);
    await new Promise((r) => setTimeout(r, 20)); // turn is running
    expect(__sessionCount()).toBe(1);

    // Advance the virtual clock past the 30-min TTL and sweep → eviction aborts
    // the in-flight controller and closes the client.
    __sweepSessions(Date.now() + 31 * 60_000);
    expect(__sessionCount()).toBe(0);

    // The stream is force-closed by eviction (well before the ~240ms it would
    // otherwise take), so the reader resolves promptly.
    await framesP;
  });

  it('C1: /chat/approve requires a pending plan request, then binds the call', async () => {
    let dispatchCount = 0;
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'p1', name: 'actor_spawn', input: { id: 'A' } }], stopReason: 'tool_use' },
        { content: null, toolCalls: [{ id: 'p2', name: 'actor_spawn', input: { id: 'A' } }], stopReason: 'tool_use' },
        { deltas: ['ok'], content: 'ok', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [
        { name: 'actor_spawn', description: 'spawn', input_schema: { type: 'object', properties: {} } },
      ],
      dispatchTool: async () => {
        dispatchCount++;
        return { ok: true };
      },
    }));

    // Approve with nothing pending → 409.
    const early = await fetch(`${url}/chat/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'pm' }),
    });
    expect(early.status).toBe(404); // session doesn't exist yet

    // Turn 1: destructive tool under Plan Mode → plan_request pause, NO dispatch.
    const turn1 = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'pm', prompt: 'spawn it', provider: 'mock' }),
    });
    const frames1 = await readAllFrames(turn1.body!);
    const plan = frames1.find((f) => f.event === 'plan_request')!.data as { args_hash: string };
    expect(plan.args_hash).toBeTruthy();
    expect(dispatchCount).toBe(0);

    // Approve binds to the paused call.
    const approve = await fetch(`${url}/chat/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'pm' }),
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()).approved).toBe(true);

    // Approving again (already consumed) → 409, nothing pending.
    const again = await fetch(`${url}/chat/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'pm' }),
    });
    expect(again.status).toBe(409);

    // Turn 2: resume dispatches the approved call exactly once → end_turn.
    const turn2 = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'pm', prompt: 'spawn it', provider: 'mock' }),
    });
    const frames2 = await readAllFrames(turn2.body!);
    const done = frames2.find((f) => f.event === 'done')!.data as { reason: string };
    expect(done.reason).toBe('end_turn');
    expect(dispatchCount).toBe(1);
  });

  it('the API key never appears in any stream frame or log', async () => {
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { deltas: ['ok'], content: 'ok', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      dispatchTool: async () => ({}),
    }));
    // Register the canary key for this session.
    await fetch(`${url}/chat/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sec', provider: 'mock', api_key: FAKE_KEY }),
    });
    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sec', prompt: 'hi' }),
    });
    const raw = await res.text();
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain('LEAK-CANARY');
  });

  // ── Archetype loader wiring (issue #356) ─────────────────────────────────
  // These exercise the REAL hayba.agents.json shipped at the package root
  // (chat-server.ts resolves `body.archetype` via the default manifest path,
  // there is no injection seam for a test fixture here) so the assertions
  // below are pinned to that file's current 'asset-manager' entry.
  describe('archetype wiring', () => {
    /** Records the `system` prompt and tool names offered on each stream() call. */
    function makeRecordingClientFactory(script: ScriptStep[]): {
      factory: () => LLMClient;
      calls: Array<{ system: string; toolNames: string[] }>;
    } {
      const calls: Array<{ system: string; toolNames: string[] }> = [];
      let turn = 0;
      const factory = () =>
        ({
          provider: 'mock',
          model: 'fake',
          protocol: 'anthropic',
          async complete() {
            throw new Error('not used');
          },
          async *stream(params: { system: string; tools?: Array<{ name: string }> }) {
            calls.push({ system: params.system, toolNames: (params.tools ?? []).map((t) => t.name) });
            const step = script[turn++] ?? {
              content: null,
              toolCalls: [],
              stopReason: 'end_turn' as const,
            };
            for (const t of step.deltas ?? []) yield { type: 'text_delta' as const, text: t };
            yield {
              type: 'done' as const,
              response: { content: step.content, toolCalls: step.toolCalls, stopReason: step.stopReason },
            };
          },
        }) as unknown as LLMClient;
      return { factory, calls };
    }

    it('a known archetype id applies its system_prompt (tool_filter left to the live registry)', async () => {
      const { factory, calls } = makeRecordingClientFactory([
        { deltas: ['ok'], content: 'ok', toolCalls: [], stopReason: 'end_turn' },
      ]);
      ({ server, url } = startApp({
        createClient: factory as never,
        dispatchTool: async () => ({}),
        // No `tools` override here: omitting it forces the real
        // buildToolCatalog() path, which is what archetypeFilter feeds into.
      }));

      const res = await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'arch1', prompt: 'hi', provider: 'mock', archetype: 'asset-manager' }),
      });
      const frames = await readAllFrames(res.body!);
      expect(frames.at(-1)!.event).toBe('done');
      expect(calls).toHaveLength(1);
      // The asset-manager system_prompt (hayba.agents.json) mentions asset mapping —
      // distinct from DEFAULT_SYSTEM, which never does.
      expect(calls[0].system).toMatch(/Content Browser assets/);
      expect(calls[0].system).not.toMatch(/in-editor copilot/);
    });

    it('an unknown archetype id fails loudly with a specific error frame, not silence', async () => {
      const { factory, calls } = makeRecordingClientFactory([
        { deltas: ['ok'], content: 'ok', toolCalls: [], stopReason: 'end_turn' },
      ]);
      ({ server, url } = startApp({
        createClient: factory as never,
        dispatchTool: async () => ({}),
      }));

      const res = await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 'arch2',
          prompt: 'hi',
          provider: 'mock',
          archetype: 'not-a-real-archetype',
        }),
      });
      const frames = await readAllFrames(res.body!);
      const err = frames.find((f) => f.event === 'error')!.data as { error: string; kind?: string };
      expect(err.error).toMatch(/unknown archetype id "not-a-real-archetype"/);
      expect(err.error).toMatch(/director/); // names a KNOWN id, not just "invalid"
      expect(frames.at(-1)!.event).toBe('done');
      // The LLM was never even called — the gate fires before dispatch.
      expect(calls).toHaveLength(0);
    });

    it('hand-passed archetype_filter keeps working with no archetype id given', async () => {
      const { factory, calls } = makeRecordingClientFactory([
        { deltas: ['ok'], content: 'ok', toolCalls: [], stopReason: 'end_turn' },
      ]);
      ({ server, url } = startApp({
        createClient: factory as never,
        dispatchTool: async () => ({}),
        tools: [
          { name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } },
        ],
      }));

      const res = await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: 'arch3',
          prompt: 'hi',
          provider: 'mock',
          archetype_filter: ['get_thing'],
        }),
      });
      const frames = await readAllFrames(res.body!);
      expect(frames.at(-1)!.event).toBe('done');
      expect(calls).toHaveLength(1);
      // No archetype id supplied → the default system prompt applies unchanged.
      expect(calls[0].system).toMatch(/in-editor copilot/);
    });
  });
});
