/**
 * Sidecar SSE chat server (Task 4) — the HTTP surface the C++ Slate panel (and
 * any localhost client) talks to for the BYOK in-editor copilot.
 *
 * Routes (all localhost-only; see `isLoopback`):
 *
 *   POST /chat/stream   — start (or resume) a per-session agent turn. Streams
 *                         Server-Sent Events. Frames:
 *                             event: text_delta   data: {text}
 *                             event: tool_call    data: {id,name,input}
 *                             event: tool_result  data: {id,name,result,isError?}
 *                             event: plan_request data: {id,name,input,source,hint?}
 *                             event: done         data: {reason,assistant_text,
 *                                                        tool_trace[],usage?,
 *                                                        cancelled?,partial_text}
 *                             event: error        data: {error,kind?}
 *                         Every frame carries an SSE `id:` (monotonic seq) so a
 *                         client can reconnect with {session_id,last_seq} to
 *                         replay only missed frames. Heartbeat comment frames
 *                         (`: ping`) are sent every ~15s.
 *
 *   POST /chat/cancel   — {session_id}: aborts the in-flight loop; the stream
 *                         ends with a done frame carrying {cancelled:true,
 *                         partial_text}.
 *
 *   POST /chat/approve  — {session_id}: marks the session Plan-Mode-approved so
 *                         the NEXT /chat/stream turn dispatches the previously
 *                         gated tool. (The loop RETURNS on plan_request; resume
 *                         is a new turn, not an in-place continuation — see the
 *                         plan_request contract in the Task-4 report.)
 *
 *   POST /chat/config   — {session_id?,provider,model?,base_url?,api_key}: set
 *                         the provider + key for a session IN MEMORY only. The
 *                         key is NEVER persisted, echoed, or logged.
 *   GET  /chat/config   — masked read (provider, model, key_last4) only.
 *
 * KEY SOURCE: option (b) from the brief — an in-memory registration endpoint.
 * Task 6 replaces this source with the C++ DPAPI vault (the sidecar will read
 * the key via a localhost `get_setting`-style handshake); the frame/route
 * contract here does not change when that lands.
 */

import type { Express, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createLLMClient, type LLMMessage } from '../agents/llm-client.js';
import { getProvider } from '../agents/providers.js';
import { runAgentLoop, type AgentEvent, type DispatchTool } from './agent-loop.js';
import type { LLMTool } from '../agents/llm-client.js';
import { createChatDispatcher } from './tool-dispatch.js';

// ---------------------------------------------------------------------------
// Localhost enforcement
// ---------------------------------------------------------------------------

/** True for IPv4/IPv6 loopback (incl. IPv4-mapped IPv6). Never network-exposed. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  );
}

function requireLoopback(req: Request, res: Response): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  res.status(403).json({ error: 'chat routes are localhost-only' });
  return false;
}

// ---------------------------------------------------------------------------
// In-memory config store (option b). Never persisted / logged / echoed.
// ---------------------------------------------------------------------------

interface SessionConfig {
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

const DEFAULT_CONFIG_KEY = '__default__';
const configStore = new Map<string, SessionConfig>();

function last4(key: string | undefined): string | null {
  if (!key) return null;
  return key.length <= 4 ? '****' : key.slice(-4);
}

function resolveSessionConfig(sessionId: string | undefined): SessionConfig | undefined {
  if (sessionId && configStore.has(sessionId)) return configStore.get(sessionId);
  return configStore.get(DEFAULT_CONFIG_KEY);
}

// ---------------------------------------------------------------------------
// Session store (in-memory). One turn runs server-side per session; frames
// buffer while the client is disconnected so a reconnect can replay them.
// ---------------------------------------------------------------------------

interface BufferedFrame {
  seq: number;
  event: string;
  data: unknown;
}

interface ToolTraceEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

interface ChatSession {
  id: string;
  abortController: AbortController;
  seq: number;
  buffer: BufferedFrame[];
  messages: LLMMessage[];
  clients: Set<Response>;
  running: boolean;
  planApproved: boolean;
  assistantText: string;
  toolTrace: ToolTraceEntry[];
  /** Set once the current/last turn has ended (final done frame emitted). */
  lastDone?: BufferedFrame;
}

const BUFFER_LIMIT = 500;
const HEARTBEAT_MS = 15_000;
const sessions = new Map<string, ChatSession>();

let sessionCounter = 0;
function newSessionId(): string {
  sessionCounter += 1;
  return `sess_${Date.now().toString(36)}_${sessionCounter}`;
}

function getOrCreateSession(id: string): ChatSession {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      abortController: new AbortController(),
      seq: 0,
      buffer: [],
      messages: [],
      clients: new Set(),
      running: false,
      planApproved: false,
      assistantText: '',
      toolTrace: [],
    };
    sessions.set(id, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

function writeFrame(res: Response, frame: BufferedFrame): void {
  // `id:` lets a reconnecting client tell us its last_seq. event + JSON data.
  res.write(`id: ${frame.seq}\n`);
  res.write(`event: ${frame.event}\n`);
  res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
}

/** Assign a seq, buffer (bounded), and fan out to every attached client. */
function emit(session: ChatSession, event: string, data: unknown): BufferedFrame {
  session.seq += 1;
  const frame: BufferedFrame = { seq: session.seq, event, data };
  session.buffer.push(frame);
  if (session.buffer.length > BUFFER_LIMIT) session.buffer.shift();
  for (const client of session.clients) {
    try {
      writeFrame(client, frame);
    } catch {
      /* client vanished mid-write; close handler will detach it */
    }
  }
  return frame;
}

function replayMissed(session: ChatSession, res: Response, lastSeq: number): void {
  for (const frame of session.buffer) {
    if (frame.seq > lastSeq) writeFrame(res, frame);
  }
}

// ---------------------------------------------------------------------------
// Message normalization
// ---------------------------------------------------------------------------

function normalizeMessages(body: {
  messages?: unknown;
  prompt?: unknown;
}): LLMMessage[] | null {
  if (Array.isArray(body.messages)) {
    const ok = body.messages.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        (((m as { role?: unknown }).role === 'user') ||
          ((m as { role?: unknown }).role === 'assistant')),
    );
    return ok ? (body.messages as LLMMessage[]) : null;
  }
  if (typeof body.prompt === 'string' && body.prompt.length > 0) {
    return [{ role: 'user', content: body.prompt }];
  }
  return null;
}

const DEFAULT_SYSTEM =
  'You are the Hayba in-editor copilot. You help build Unreal Engine worlds by ' +
  'calling Hayba tools. Prefer reads before writes; respect Plan Mode.';

// ---------------------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------------------

export interface ChatRoutesOptions {
  /** Override the tool dispatcher (test seam). Defaults to full-coverage dispatch. */
  dispatchTool?: DispatchTool;
  /** Inject a client factory (test seam). Defaults to createLLMClient. */
  createClient?: typeof createLLMClient;
  /** Default system prompt. */
  system?: string;
  /**
   * Explicit tool catalog offered to the model. If omitted, the loop builds it
   * from the live registry (filtered by archetype). Primarily a test seam.
   */
  tools?: LLMTool[];
}

/**
 * Register the /chat/* routes onto an existing Express app so the sidecar port
 * serves them. Call from `registerApiRoutes`.
 */
export function registerChatRoutes(app: Express, options: ChatRoutesOptions = {}): void {
  const dispatchTool = options.dispatchTool ?? createChatDispatcher();
  const makeClient = options.createClient ?? createLLMClient;
  const system = options.system ?? DEFAULT_SYSTEM;

  // ── POST /chat/config ────────────────────────────────────────────────────
  app.post('/chat/config', (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    const body = req.body as {
      session_id?: string;
      provider?: string;
      model?: string;
      base_url?: string;
      api_key?: string;
    };
    if (!body.provider || typeof body.provider !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (!getProvider(body.provider)) {
      return res.status(400).json({ error: `unknown provider: ${body.provider}` });
    }
    const key = body.session_id || DEFAULT_CONFIG_KEY;
    configStore.set(key, {
      provider: body.provider,
      model: body.model,
      baseURL: body.base_url,
      apiKey: body.api_key,
    });
    // NEVER echo the key. Return masked confirmation only.
    return res.json({
      ok: true,
      provider: body.provider,
      model: body.model ?? getProvider(body.provider)?.defaultModel ?? null,
      key_last4: last4(body.api_key),
    });
  });

  // ── GET /chat/config ─────────────────────────────────────────────────────
  app.get('/chat/config', (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    const cfg = resolveSessionConfig(sessionId);
    if (!cfg) return res.json({ configured: false });
    return res.json({
      configured: true,
      provider: cfg.provider,
      model: cfg.model ?? getProvider(cfg.provider)?.defaultModel ?? null,
      key_last4: last4(cfg.apiKey), // masked — never the raw key
    });
  });

  // ── POST /chat/cancel ────────────────────────────────────────────────────
  app.post('/chat/cancel', (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    const { session_id } = req.body as { session_id?: string };
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    const session = sessions.get(session_id);
    if (!session) return res.status(404).json({ error: 'unknown session' });
    session.abortController.abort();
    return res.json({ ok: true, cancelled: true });
  });

  // ── POST /chat/approve ───────────────────────────────────────────────────
  app.post('/chat/approve', (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    const { session_id } = req.body as { session_id?: string };
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    const session = sessions.get(session_id);
    if (!session) return res.status(404).json({ error: 'unknown session' });
    session.planApproved = true;
    // Resume = the C++ panel re-issues POST /chat/stream with the same
    // session_id; the stored transcript continues and the gated tool now runs.
    return res.json({ ok: true, approved: true });
  });

  // ── POST /chat/stream ────────────────────────────────────────────────────
  app.post('/chat/stream', async (req: Request, res: Response) => {
    if (!requireLoopback(req, res)) return;
    const body = req.body as {
      session_id?: string;
      messages?: LLMMessage[];
      prompt?: string;
      provider?: string;
      model?: string;
      archetype?: string;
      archetype_filter?: string[];
      last_seq?: number;
    };

    // SSE headers.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* closed */
      }
    }, HEARTBEAT_MS);
    const cleanup = (): void => clearInterval(heartbeat);

    // ── RESUME path: existing session + last_seq → replay, don't re-dispatch ──
    const existing = body.session_id ? sessions.get(body.session_id) : undefined;
    const isResume = existing !== undefined && typeof body.last_seq === 'number';
    if (isResume && existing) {
      existing.clients.add(res);
      replayMissed(existing, res, body.last_seq as number);
      // If the turn already finished, we've replayed the final done frame; end.
      if (!existing.running) {
        existing.clients.delete(res);
        cleanup();
        return res.end();
      }
      // Turn still running: stay attached for live frames; detach on disconnect.
      // NB: res 'close' (not req 'close') — req closes as soon as the POST body
      // is received, which would detach the client before any frame is written.
      res.on('close', () => {
        existing.clients.delete(res);
        cleanup();
      });
      return; // no new loop — this is the anti-duplicate-dispatch guarantee
    }

    // Reject starting a second concurrent turn on a running session.
    if (existing && existing.running) {
      cleanup();
      return res.status(409).json({ error: 'session already has a turn in flight' });
    }

    // ── NEW TURN path ────────────────────────────────────────────────────────
    const sessionId = body.session_id || newSessionId();
    const session = getOrCreateSession(sessionId);
    // Fresh AbortController per turn (a prior cancel leaves an aborted one).
    session.abortController = new AbortController();
    session.running = true;
    session.assistantText = '';
    session.toolTrace = [];
    session.clients.add(res);

    // Resolve messages: explicit body wins; else reuse stored transcript
    // (post-approval resume) if present.
    let messages = normalizeMessages(body);
    if (!messages && session.messages.length > 0) messages = session.messages;
    if (!messages) {
      emit(session, 'error', { error: 'messages or prompt is required', kind: 'bad_request' });
      finalize(session, 'error');
      session.clients.delete(res);
      cleanup();
      return res.end();
    }
    session.messages = messages;

    // Resolve provider/model/key: body overrides > session config > default cfg.
    const cfg = resolveSessionConfig(sessionId);
    const provider = body.provider ?? cfg?.provider ?? 'mock';
    const model = body.model ?? cfg?.model;
    if (!getProvider(provider)) {
      emit(session, 'error', { error: `unknown provider: ${provider}`, kind: 'config' });
      finalize(session, 'error');
      session.running = false;
      session.clients.delete(res);
      cleanup();
      return res.end();
    }

    let client;
    try {
      client = makeClient({
        provider,
        model,
        baseURL: cfg?.baseURL,
        apiKey: body.provider ? undefined : cfg?.apiKey, // key follows the resolved provider
      });
    } catch (err) {
      emit(session, 'error', {
        error: err instanceof Error ? err.message : String(err),
        kind: 'config',
      });
      finalize(session, 'error');
      session.running = false;
      session.clients.delete(res);
      cleanup();
      return res.end();
    }

    // Detach this client on disconnect; the loop keeps running (frames buffer).
    // Use res 'close' — req 'close' fires as soon as the POST body is received,
    // which would detach the client before the first frame is written.
    res.on('close', () => {
      session.clients.delete(res);
      cleanup();
    });

    // Drive the loop server-side, independent of the HTTP connection lifetime.
    void runTurn(session, {
      client,
      system,
      messages,
      archetypeFilter: body.archetype_filter,
      tools: options.tools,
      dispatchTool,
      signal: session.abortController.signal,
      planApproved: session.planApproved,
    }).finally(() => {
      cleanup();
      // Reset one-shot approval so a later turn re-gates.
      session.planApproved = false;
    });

    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Turn driver — consumes the agent loop and translates events into frames.
// ---------------------------------------------------------------------------

interface RunTurnParams {
  client: ReturnType<typeof createLLMClient>;
  system: string;
  messages: LLMMessage[];
  archetypeFilter?: string[];
  tools?: LLMTool[];
  dispatchTool: DispatchTool;
  signal: AbortSignal;
  planApproved: boolean;
}

/** Emit the single consolidated final done frame + mark the turn finished. */
function finalize(
  session: ChatSession,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  const frame = emit(session, 'done', {
    reason,
    assistant_text: session.assistantText,
    partial_text: session.assistantText,
    tool_trace: session.toolTrace,
    cancelled: reason === 'aborted' || reason === 'cancelled',
    ...extra,
  });
  console.error("[dbg] finalize reason="+reason+" clients="+session.clients.size);
  session.lastDone = frame;
  session.running = false;
  // Close every attached SSE client — the turn is over. Buffered frames remain
  // for a later resume (reconnect with last_seq).
  for (const client of session.clients) {
    try {
      client.end();
    } catch {
      /* already closed */
    }
  }
  session.clients.clear();
}

async function runTurn(session: ChatSession, params: RunTurnParams): Promise<void> {
  console.error("[dbg] runTurn start clients="+session.clients.size);
  let finalReason: string | null = null;
  let lastError: { error: string; kind?: string } | null = null;

  try {
    for await (const ev of runAgentLoop({
      client: params.client,
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      archetypeFilter: params.archetypeFilter,
      dispatchTool: params.dispatchTool,
      signal: params.signal,
      planMode: true, // honour Plan Mode; UE side is authoritative, TS side gated
      planApproved: params.planApproved,
    })) {
      forwardEvent(session, ev, (r) => (finalReason = r), (e) => (lastError = e));
      if (finalReason) break; // loop's own done/plan_request/aborted terminus
    }
  } catch (err) {
    lastError = { error: err instanceof Error ? err.message : String(err), kind: 'internal' };
  }

  // Consolidated terminal frame.
  if (finalReason === 'aborted') {
    finalize(session, 'aborted');
  } else if (lastError && !finalReason) {
    finalize(session, 'error', { error: lastError });
  } else {
    finalize(session, finalReason ?? 'end_turn', lastError ? { error: lastError } : {});
  }
}

/** Translate one loop AgentEvent into buffered SSE frames + trace bookkeeping. */
function forwardEvent(
  session: ChatSession,
  ev: AgentEvent,
  setReason: (r: string) => void,
  setError: (e: { error: string; kind?: string }) => void,
): void {
  switch (ev.type) {
    case 'text_delta':
      session.assistantText += ev.text;
      emit(session, 'text_delta', { text: ev.text });
      break;
    case 'tool_call':
      session.toolTrace.push({ id: ev.call.id, name: ev.call.name, input: ev.call.input });
      emit(session, 'tool_call', { id: ev.call.id, name: ev.call.name, input: ev.call.input });
      break;
    case 'tool_result': {
      const entry = session.toolTrace.find((t) => t.id === ev.id);
      if (entry) {
        entry.result = ev.result;
        entry.isError = ev.isError;
      }
      emit(session, 'tool_result', {
        id: ev.id,
        name: ev.name,
        result: ev.result,
        isError: ev.isError,
      });
      break;
    }
    case 'plan_request':
      emit(session, 'plan_request', {
        id: ev.call.id,
        name: ev.call.name,
        input: ev.call.input,
        source: ev.source,
        hint: ev.hint,
      });
      // Loop RETURNS after plan_request — the turn pauses pending approval.
      setReason('plan_request');
      break;
    case 'done':
      setReason(ev.reason);
      break;
    case 'error':
      setError({ error: ev.error, kind: ev.kind });
      emit(session, 'error', { error: ev.error, kind: ev.kind });
      if (ev.kind === 'aborted') setReason('aborted');
      break;
  }
}

// ---------------------------------------------------------------------------
// Test / lifecycle helpers
// ---------------------------------------------------------------------------

/** Clear all in-memory session + config state (tests). */
export function __resetChatState(): void {
  sessions.clear();
  configStore.clear();
  sessionCounter = 0;
}

/** Introspection for tests: the port an app is listening on. */
export function addressPort(address: AddressInfo | string | null): number {
  if (address && typeof address === 'object') return address.port;
  throw new Error('server not listening on a TCP port');
}
