import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerChatRoutes,
  __resetChatState,
  __sweepSessions,
  __sweepChatContexts,
  __contextPrunerCount,
  __sessionCount,
  isLoopback,
  getConfigEntry,
} from '../../src/chat/chat-server.js';
import { resolveConfig, type LLMClient, type LLMStreamEvent } from '../../src/agents/llm-client.js';
import { temporarySessionStore } from '../../src/chat/session-store.test-helpers.js';
import {
  CHAT_CONTEXT_TTL_MS,
  chatSessionDir,
  loadChatContext,
  loadChatState,
  pruneChatContexts,
  saveChatContext,
} from '../../src/chat/session-store.js';

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
  registerChatRoutes(app, { sessionStore: temporarySessionStore(), ...opts });
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('sidecar SSE chat server', () => {
  let server: Server;
  let url: string;
  let sessionDir: string;

  beforeEach(() => {
    __resetChatState();
    sessionDir = mkdtempSync(join(tmpdir(), 'hayba-chat-test-'));
  });
  afterEach(() => {
    server?.close();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('isLoopback recognises loopback addresses only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it('rejects an unknown work mode before opening an SSE stream', async () => {
    ({ server, url } = startApp({ dispatchTool: async () => ({}) }));

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'mode-invalid', prompt: 'hi', provider: 'mock', mode: 'unsafe' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid agent mode' });
  });

  it('keeps Explore mode read-only by withholding destructive tools from dispatch', async () => {
    let dispatches = 0;
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'write', name: 'actor_spawn', input: {} }], stopReason: 'tool_use' },
        { content: 'I cannot change the world in Explore.', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [{ name: 'actor_spawn', description: 'spawn an actor', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: async () => {
        dispatches++;
        return { ok: true };
      },
    }));

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'mode-explore', prompt: 'spawn a tree', provider: 'mock', mode: 'explore' }),
    });
    const frames = await readAllFrames(res.body!);

    expect(dispatches).toBe(0);
    expect(frames.find((frame) => frame.event === 'tool_result')!.data).toMatchObject({ isError: true });
    expect(frames.at(-1)!.event).toBe('done');
  });

  it('withholds unclassified tools in Explore mode', async () => {
    let dispatches = 0;
    ({ server, url } = startApp({
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'unknown', name: 'custom_action', input: {} }], stopReason: 'tool_use' },
        { content: 'That action is unavailable in Explore.', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [{ name: 'custom_action', description: 'unknown effect', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: async () => { dispatches++; return { ok: true }; },
    }));
    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'mode-unknown', prompt: 'do it', provider: 'mock', mode: 'explore' }),
    });
    const frames = await readAllFrames(res.body!);
    expect(dispatches).toBe(0);
    expect(frames.find((frame) => frame.event === 'tool_result')!.data).toMatchObject({ isError: true });
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
      tools: [{ name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } }],
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

  it('restores the same session context after restart and keeps a new session clean', async () => {
    const seen: Array<Array<{ role: string; content: unknown }>> = [];
    let reply = 0;
    const createClient = () =>
      ({
        provider: 'mock',
        model: 'fake',
        protocol: 'anthropic',
        async complete() {
          throw new Error('not used');
        },
        async *stream(params: { messages: Array<{ role: string; content: unknown }> }) {
          seen.push(params.messages.map((m) => ({ ...m })));
          const content = `answer ${++reply}`;
          yield { type: 'text_delta' as const, text: content };
          yield { type: 'done' as const, response: { content, toolCalls: [], stopReason: 'end_turn' as const } };
        },
      }) as unknown as LLMClient;
    const ask = async (id: string, prompt: string) => {
      const res = await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: id, prompt, provider: 'mock' }),
      });
      expect(res.status).toBe(200);
      expect((await readAllFrames(res.body!)).at(-1)?.event).toBe('done');
    };
    ({ server, url } = startApp({ createClient: createClient as never, sessionDir, tools: [] }));
    await ask('ue_abc123', 'first question');
    expect(readdirSync(sessionDir)).toContain('ctx_ue_abc123.json');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetChatState(); // models a fresh sidecar process
    ({ server, url } = startApp({ createClient: createClient as never, sessionDir, tools: [] }));
    const staleResume = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'ue_abc123', last_seq: 1, prompt: 'follow up' }),
    });
    expect(staleResume.status).toBe(409);
    expect(seen).toHaveLength(1);
    await ask('ue_abc123', 'follow up');
    await ask('ue_different', 'unrelated');
    expect(seen[1]).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'follow up' },
    ]);
    expect(seen[2]).toEqual([{ role: 'user', content: 'unrelated' }]);
  });

  it('rejects unsafe session ids before creating a file', async () => {
    ({ server, url } = startApp({ sessionDir, tools: [] }));
    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: '../escape', prompt: 'hello' }),
    });
    expect(res.status).toBe(400);
    expect(readdirSync(sessionDir)).toEqual([]);
  });

  it('ignores corrupt or partial snapshots and prunes expired context', () => {
    writeFileSync(join(sessionDir, 'ctx_broken.json'), '{"version":1,');
    expect(loadChatContext(sessionDir, 'broken')).toEqual([]);
    expect(readdirSync(sessionDir)).not.toContain('ctx_broken.json');
    saveChatContext(sessionDir, 'old', [{ role: 'user', content: 'old' }], Date.now() - CHAT_CONTEXT_TTL_MS - 1);
    expect(loadChatContext(sessionDir, 'old')).toEqual([]);
    pruneChatContexts(sessionDir, Date.now() + CHAT_CONTEXT_TTL_MS + 1);
    expect(readdirSync(sessionDir)).not.toContain('ctx_old.json');
  });

  it('removes an expired snapshot on load and at route registration without a new save', () => {
    const expired = JSON.stringify({
      version: 1,
      id: 'expired',
      savedAt: Date.now() - CHAT_CONTEXT_TTL_MS - 1,
      messages: [{ role: 'user', content: 'stale' }],
    });
    writeFileSync(join(sessionDir, 'ctx_expired.json'), expired);
    expect(loadChatContext(sessionDir, 'expired')).toEqual([]);
    expect(readdirSync(sessionDir)).not.toContain('ctx_expired.json');
    writeFileSync(join(sessionDir, 'ctx_expired.json'), expired);
    ({ server, url } = startApp({ sessionDir, tools: [] }));
    expect(readdirSync(sessionDir)).not.toContain('ctx_expired.json');
  });

  it('periodically prunes idle disk context with one lifecycle-managed timer', () => {
    const now = Date.now();
    writeFileSync(
      join(sessionDir, 'ctx_idle_disk.json'),
      JSON.stringify({
        version: 1,
        id: 'idle_disk',
        savedAt: now,
        messages: [{ role: 'user', content: 'context' }],
      }),
    );
    ({ server, url } = startApp({ sessionDir, tools: [] }));
    expect(__contextPrunerCount()).toBe(1);
    registerChatRoutes(express(), { sessionDir, tools: [] });
    expect(__contextPrunerCount()).toBe(1);
    expect(readdirSync(sessionDir)).toContain('ctx_idle_disk.json');
    __sweepChatContexts(now + CHAT_CONTEXT_TTL_MS + 1);
    expect(readdirSync(sessionDir)).not.toContain('ctx_idle_disk.json');
    __resetChatState();
    expect(__contextPrunerCount()).toBe(0);
  });

  it('uses per-user project-keyed state and supports Windows reserved session ids', () => {
    const original = process.env.HAYBA_CHAT_SESSION_DIR;
    const stateVariable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';
    const previousState = process.env[stateVariable];
    try {
      delete process.env.HAYBA_CHAT_SESSION_DIR;
      process.env[stateVariable] = sessionDir;
      const resolved = chatSessionDir();
      expect(resolved).toMatch(/HaybaMCP[\\/]chat-context[\\/][a-f0-9]{32}$/);
      const userState = process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : sessionDir;
      expect(resolved.startsWith(userState)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.HAYBA_CHAT_SESSION_DIR;
      else process.env.HAYBA_CHAT_SESSION_DIR = original;
      if (previousState === undefined) delete process.env[stateVariable];
      else process.env[stateVariable] = previousState;
    }
    saveChatContext(sessionDir, 'CON', [{ role: 'user', content: 'safe' }]);
    expect(readdirSync(sessionDir)).toContain('ctx_CON.json');
    expect(loadChatContext(sessionDir, 'CON')).toEqual([{ role: 'user', content: 'safe' }]);
  });

  it('reports a context write failure in the SSE result', async () => {
    const blockedDir = join(sessionDir, 'not-a-directory');
    writeFileSync(blockedDir, 'file');
    ({ server, url } = startApp({
      sessionDir: blockedDir,
      createClient: makeFakeClientFactory([
        { deltas: ['answer'], content: 'answer', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [],
    }));
    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'write_fail', prompt: 'hi', provider: 'mock' }),
    });
    const frames = await readAllFrames(res.body!);
    expect(frames.find((f) => f.event === 'error')?.data).toEqual(expect.objectContaining({ kind: 'persistence' }));
    expect(frames.at(-1)?.data).toEqual(expect.objectContaining({ context_persisted: false }));
  });

  it('persists bounded redacted text without tool payloads or approval state', () => {
    saveChatContext(sessionDir, 'safe', [
      {
        role: 'user',
        content: 'password=supersecret Authorization: Bearer abcdefghijklmnop sk-ant-LEAK-CANARY-000111222333',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 't1', name: 'create_thing', input: { token: 'tool-secret' } },
        ],
      },
    ]);
    const raw = readFileSync(join(sessionDir, 'ctx_safe.json'), 'utf8');
    expect(raw).not.toContain('supersecret');
    expect(raw).not.toContain('abcdefghijklmnop');
    expect(raw).not.toContain('LEAK-CANARY');
    expect(raw).not.toContain('tool-secret');
    expect(raw).not.toContain('tool_use');
    expect(loadChatContext(sessionDir, 'safe')).toEqual([
      { role: 'user', content: expect.stringContaining('[REDACTED:') },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('restores pending warning review after a sidecar restart', async () => {
    const warningId = 'ui_engine_default_font_0123456789ab';
    ({ server, url } = startApp({
      sessionDir,
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'v1', name: 'validator_run', input: {} }], stopReason: 'tool_use' },
        { content: 'I will review it.', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [{ name: 'validator_run', description: 'validate', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: async () => ({ validator: { warning_ids: [warningId] } }),
    }));
    const request = (prompt: string) => fetch(`${url}/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'warning_restart', prompt, provider: 'mock' }),
    });
    let frames = await readAllFrames((await request('check fonts')).body!);
    expect(frames.at(-1)?.data).toEqual(expect.objectContaining({
      reason: 'warnings_unreviewed', pending_warning_ids: [warningId],
    }));
    expect(loadChatState(sessionDir, 'warning_restart').warnings.reviews).toEqual([
      { id: warningId, status: 'pending' },
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetChatState();
    ({ server, url } = startApp({
      sessionDir,
      createClient: makeFakeClientFactory([
        { content: 'Still pending.', toolCalls: [], stopReason: 'end_turn' },
      ]) as never,
      tools: [],
    }));
    frames = await readAllFrames((await request('follow up')).body!);
    expect(frames.at(-1)?.data).toEqual(expect.objectContaining({
      reason: 'warnings_unreviewed', pending_warning_ids: [warningId],
    }));
  });

  it('persists deferred warning disposition with a redacted reason', () => {
    saveChatContext(sessionDir, 'warning_deferred', [], Date.now(), {
      reviews: [{ id: 'ui_engine_default_font_0123456789ab', status: 'deferred',
        reason: 'Waiting on password=supersecret font approval' }],
      overflow: false,
    });
    const raw = readFileSync(join(sessionDir, 'ctx_warning_deferred.json'), 'utf8');
    expect(raw).not.toContain('supersecret');
    expect(loadChatState(sessionDir, 'warning_deferred').warnings.reviews).toEqual([
      { id: 'ui_engine_default_font_0123456789ab', status: 'deferred', reason: expect.stringContaining('[REDACTED:') },
    ]);
  });

  it('keeps at most 64 session files and 100 text messages per session', () => {
    const now = Date.now();
    for (let i = 0; i < 70; i++) {
      writeFileSync(
        join(sessionDir, `ctx_s${i}.json`),
        JSON.stringify({
          version: 1,
          id: `s${i}`,
          savedAt: now,
          messages: [{ role: 'user', content: 'context' }],
        }),
      );
    }
    pruneChatContexts(sessionDir);
    expect(readdirSync(sessionDir)).toHaveLength(64);
    saveChatContext(
      sessionDir,
      'bounded',
      Array.from({ length: 120 }, (_, i) => ({
        role: 'user' as const,
        content: `message ${i}`,
      })),
    );
    const loaded = loadChatContext(sessionDir, 'bounded');
    expect(loaded).toHaveLength(100);
    expect(loaded[0]).toEqual({ role: 'user', content: 'message 20' });
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
      tools: [{ name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } }],
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

  it('config: an omitted key uses the provider environment; an explicit empty key clears it', async () => {
    ({ server, url } = startApp({}));
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    try {
      const set = async (sessionId: string, apiKey?: string) =>
        fetch(`${url}/chat/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            provider: 'anthropic',
            ...(apiKey !== undefined ? { api_key: apiKey } : {}),
          }),
        });

      expect((await set('env-key', 'previous-vault-key')).status).toBe(200);
      expect(getConfigEntry('env-key')?.apiKey).toBe('previous-vault-key');
      expect((await set('env-key')).status).toBe(200);
      const omitted = getConfigEntry('env-key');
      expect(omitted?.apiKey).toBeUndefined();
      expect(resolveConfig({ provider: 'anthropic', apiKey: omitted?.apiKey }).apiKey).toBe(FAKE_KEY);

      expect((await set('env-key', '')).status).toBe(200);
      const cleared = getConfigEntry('env-key');
      expect(cleared?.apiKey).toBe('');
      expect(resolveConfig({ provider: 'anthropic', apiKey: cleared?.apiKey }).apiKey).toBe('');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
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
      tools: [{ name: 'actor_spawn', description: 'spawn', input_schema: { type: 'object', properties: {} } }],
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

  it('rejects a changed prompt after approval without dispatching the old call', async () => {
    let dispatchCount = 0;
    ({ server, url } = startApp({
      sessionDir,
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'p1', name: 'actor_spawn', input: { id: 'A' } }], stopReason: 'tool_use' },
        { content: null, toolCalls: [{ id: 'p2', name: 'actor_spawn', input: { id: 'A' } }], stopReason: 'tool_use' },
      ]) as never,
      tools: [{ name: 'actor_spawn', description: 'spawn', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: async () => {
        dispatchCount++;
        return { ok: true };
      },
    }));
    const post = (path: string, body: object) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = await post('/chat/stream', { session_id: 'changed', prompt: 'spawn it', provider: 'mock' });
    expect((await readAllFrames(first.body!)).some((f) => f.event === 'plan_request')).toBe(true);
    expect((await post('/chat/approve', { session_id: 'changed' })).status).toBe(200);
    const changed = await post('/chat/stream', { session_id: 'changed', prompt: 'do not spawn', provider: 'mock' });
    expect(changed.status).toBe(409);
    expect(dispatchCount).toBe(0);
    const retry = await post('/chat/stream', { session_id: 'changed', prompt: 'spawn it', provider: 'mock' });
    expect((await readAllFrames(retry.body!)).some((f) => f.event === 'plan_request')).toBe(true);
    expect(dispatchCount).toBe(0);
  });

  it('does not restore a pending Plan-Mode approval after restart', async () => {
    let dispatchCount = 0;
    const options = {
      sessionDir,
      createClient: makeFakeClientFactory([
        { content: null, toolCalls: [{ id: 'p1', name: 'actor_spawn', input: { id: 'A' } }], stopReason: 'tool_use' },
      ]) as never,
      tools: [{ name: 'actor_spawn', description: 'spawn', input_schema: { type: 'object' as const, properties: {} } }],
      dispatchTool: async () => {
        dispatchCount++;
        return { ok: true };
      },
    };
    ({ server, url } = startApp(options));
    const turn = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'plan_restart', prompt: 'spawn it', provider: 'mock' }),
    });
    expect((await readAllFrames(turn.body!)).some((f) => f.event === 'plan_request')).toBe(true);
    const disk = readFileSync(join(sessionDir, 'ctx_plan_restart.json'), 'utf8');
    expect(disk).not.toContain('approvedCall');
    expect(disk).not.toContain('pendingPlanCall');
    expect(disk).not.toContain('actor_spawn');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    __resetChatState();
    ({ server, url } = startApp(options));
    const approval = await fetch(`${url}/chat/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'plan_restart' }),
    });
    expect(approval.status).toBe(404);
    expect(dispatchCount).toBe(0);
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
        tools: [{ name: 'get_thing', description: 'read a thing', input_schema: { type: 'object', properties: {} } }],
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
