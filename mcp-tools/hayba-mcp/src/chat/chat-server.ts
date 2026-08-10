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
import {
  runAgentLoop,
  argsHash,
  type AgentEvent,
  type ApprovedCall,
  type DispatchTool,
} from './agent-loop.js';
import type { LLMTool, LLMUsage } from '../agents/llm-client.js';
import { createChatDispatcher } from './tool-dispatch.js';
import { getArchetype } from '../agents/agent-registry.js';
import { installExpressJsonRedaction, redactBoundaryValue } from '../security/secret-redaction.js';

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
// Narrow accessors for the copilot_* MCP tools (Task 5). These read/write the
// SAME in-memory configStore the /chat/config routes use, so `copilot_provider_set`
// and `POST /chat/config` are two doors onto one store — no duplicated state.
//
// TODO(Task 6): once the C++ DPAPI vault lands, `copilot_key_set`/`copilot_key_clear`
// swap their storage target to the vault (via a localhost handshake) instead of
// this in-memory map. The masked-read contract (never echo the raw key) does
// not change when that happens.
// ---------------------------------------------------------------------------

export type { SessionConfig };

/** Masked last-4 of a key, or null. Exposed so copilot tools reuse one mask rule. */
export function maskKey(key: string | undefined): string | null {
  return last4(key);
}

/** Read the resolved config (provider/model/baseURL + RAW key) for a session/default slot. */
export function getConfigEntry(sessionId?: string): SessionConfig | undefined {
  return resolveSessionConfig(sessionId);
}

/** Write (or replace) the config entry for a session/default slot. */
export function setConfigEntry(sessionId: string | undefined, cfg: SessionConfig): void {
  configStore.set(sessionId || DEFAULT_CONFIG_KEY, cfg);
}

/** Clear only the API key on a config entry, leaving provider/model/baseURL intact. */
export function clearConfigKey(sessionId?: string): void {
  const key = sessionId || DEFAULT_CONFIG_KEY;
  const existing = configStore.get(key);
  if (existing) configStore.set(key, { ...existing, apiKey: undefined });
}

/** True once `registerChatRoutes` has wired the /chat/* routes onto the sidecar app. */
export function isChatRoutesRegistered(): boolean {
  return chatRoutesRegistered;
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
  /**
   * Identity of the tool call currently paused at the Plan-Mode gate (set when a
   * plan_request is emitted). `/chat/approve` promotes this to `approvedCall`.
   */
  pendingPlanCall?: ApprovedCall;
  /**
   * Call-bound approval (C1): the ONE `{name, argsHash}` the next turn may
   * dispatch past the TS-side gate. Consumed (cleared) after the turn runs.
   */
  approvedCall?: ApprovedCall;
  assistantText: string;
  toolTrace: ToolTraceEntry[];
  /** Epoch ms of the last activity on this session; drives TTL/LRU eviction. */
  lastActivity: number;
  /** Set once the current/last turn has ended (final done frame emitted). */
  lastDone?: BufferedFrame;
}

const BUFFER_LIMIT = 500;
const HEARTBEAT_MS = 15_000;
/** Idle time after which a session is evicted (I1). */
const SESSION_TTL_MS = 30 * 60_000;
/** How often the lazy sweeper runs. */
const SWEEP_INTERVAL_MS = 60_000;
/** Hard cap on concurrent sessions; oldest inactive are LRU-evicted past this. */
const MAX_SESSIONS = 64;
const sessions = new Map<string, ChatSession>();

// ---------------------------------------------------------------------------
// Session eviction (I1): idle-TTL + LRU cap. Evicting an active session aborts
// its in-flight controller. The sweeper timer is `.unref()`d so it never keeps
// the process alive, and is started lazily on first session creation.
// ---------------------------------------------------------------------------

let sweeper: ReturnType<typeof setInterval> | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepSessions(), SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

function touch(session: ChatSession): void {
  session.lastActivity = Date.now();
}

/** Abort the in-flight turn, close attached clients, and drop the session. */
function evictSession(session: ChatSession): void {
  try {
    session.abortController.abort();
  } catch {
    /* already aborted */
  }
  for (const client of session.clients) {
    try {
      client.end();
    } catch {
      /* already closed */
    }
  }
  session.clients.clear();
  session.running = false;
  sessions.delete(session.id);
}

function sweepSessions(now: number = Date.now()): void {
  for (const session of sessions.values()) {
    if (now - session.lastActivity > SESSION_TTL_MS) evictSession(session);
  }
}

/** Enforce MAX_SESSIONS by LRU-evicting the oldest inactive (not running). */
function enforceSessionCap(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const candidates = [...sessions.values()]
    .filter((s) => !s.running)
    .sort((a, b) => a.lastActivity - b.lastActivity);
  for (const s of candidates) {
    if (sessions.size <= MAX_SESSIONS) break;
    evictSession(s);
  }
}

let sessionCounter = 0;
function newSessionId(): string {
  sessionCounter += 1;
  return `sess_${Date.now().toString(36)}_${sessionCounter}`;
}

function getOrCreateSession(id: string): ChatSession {
  startSweeper();
  sweepSessions();
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
      assistantText: '',
      toolTrace: [],
      lastActivity: Date.now(),
    };
    sessions.set(id, s);
    enforceSessionCap();
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
  // Sanitize before buffering, not merely before socket write: reconnect replay,
  // the final done frame and crash diagnostics must never retain a raw copy.
  const frame: BufferedFrame = { seq: session.seq, event, data: redactBoundaryValue(data) };
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

/**
 * True when the client's `last_seq` predates the oldest buffered frame — i.e.
 * frames between `last_seq` and the buffer head have already been evicted, so a
 * gap-free replay is impossible (I2). The buffer must be non-empty.
 */
function hasResumeGap(session: ChatSession, lastSeq: number): boolean {
  return session.buffer.length > 0 && lastSeq < session.buffer[0].seq - 1;
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
let chatRoutesRegistered = false;

export function registerChatRoutes(app: Express, options: ChatRoutesOptions = {}): void {
  chatRoutesRegistered = true;
  // `registerChatRoutes` is also used directly in tests/embedders, outside the
  // dashboard app. Response wrapping is idempotent if the dashboard already
  // installed the same shared middleware.
  installExpressJsonRedaction(app, '/chat');
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
    touch(session);
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
    touch(session);
    // C1: approval is bound to the SPECIFIC call paused at the gate, not the
    // whole turn. Without a pending plan_request there is nothing to approve.
    if (!session.pendingPlanCall) {
      return res.status(409).json({ error: 'no pending plan request to approve' });
    }
    session.approvedCall = session.pendingPlanCall;
    session.pendingPlanCall = undefined;
    // Resume = the C++ panel re-issues POST /chat/stream with the same
    // session_id; the stored transcript continues and ONLY this exact call
    // (name + argsHash) dispatches past the TS gate, once.
    return res.json({
      ok: true,
      approved: true,
      call: { name: session.approvedCall.name },
    });
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

    // ── Branch on resume vs new turn BEFORE any SSE headers are flushed (I3) ──
    // Emitting a 409 after flushHeaders() would append JSON mid-stream (the 200 +
    // SSE headers are already on the wire). So decide the disposition first, and
    // only flush SSE headers once we're committed to streaming.
    const existing = body.session_id ? sessions.get(body.session_id) : undefined;
    const isResume = existing !== undefined && typeof body.last_seq === 'number';

    // Reject a second concurrent NEW turn on a running session with a real 409.
    // (Resumes are allowed to attach to a running session — that is the point.)
    if (!isResume && existing && existing.running) {
      return res.status(409).json({ error: 'session already has a turn in flight' });
    }

    // Committed to streaming — now flush SSE headers.
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
    if (isResume && existing) {
      touch(existing);
      // I2: if last_seq predates the buffer head, the missed frames are gone —
      // signal an explicit resume_gap error instead of silently skipping them.
      if (hasResumeGap(existing, body.last_seq as number)) {
        res.write(`event: error\n`);
        res.write(
          `data: ${JSON.stringify({
            code: 'resume_gap',
            oldest_available_seq: existing.buffer[0].seq,
          })}\n\n`,
        );
        cleanup();
        return res.end();
      }
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

    // ── NEW TURN path ────────────────────────────────────────────────────────
    const sessionId = body.session_id || newSessionId();
    const session = getOrCreateSession(sessionId);
    touch(session);
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

    // Resolve `archetype` (an id into hayba.agents.json) to its tool_filter +
    // system_prompt. Hand-passed `archetype_filter` keeps working unchanged —
    // this is additive: if both are given, the explicit filter wins (the
    // caller asked for something more specific than the archetype default),
    // but the archetype's system_prompt still applies.
    let archetypeFilter = body.archetype_filter;
    let turnSystem = system;
    if (body.archetype) {
      try {
        const archetype = getArchetype(body.archetype);
        turnSystem = archetype.system_prompt;
        if (!archetypeFilter) archetypeFilter = archetype.tool_filter;
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
    }

    // Resolve provider/model/key: body overrides > session config > default cfg.
    const cfg = resolveSessionConfig(sessionId);
    const provider = body.provider ?? cfg?.provider ?? 'mock';
    const model = body.model ?? cfg?.model;
    // The stored key belongs to the CONFIGURED provider. If the request names a
    // DIFFERENT provider, that key must not be reused (M2), so we drop it and let
    // the client factory source the key from the environment for the new
    // provider. If the request omits provider, or names the SAME provider as the
    // config, the configured key is the right one to use.
    const useConfiguredKey = !body.provider || body.provider === cfg?.provider;
    const resolvedApiKey = useConfiguredKey ? cfg?.apiKey : undefined;
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
        apiKey: resolvedApiKey, // key follows the resolved provider (see above)
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
      system: turnSystem,
      messages,
      archetypeFilter,
      tools: options.tools,
      dispatchTool,
      signal: session.abortController.signal,
      approvedCall: session.approvedCall,
    }).finally(() => {
      cleanup();
      // Consume the one-shot call-bound approval so a later turn re-gates.
      session.approvedCall = undefined;
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
  /** Call-bound Plan-Mode approval for this turn (C1); undefined = re-gate. */
  approvedCall?: ApprovedCall;
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
  let finalReason: string | null = null;
  let lastError: { error: string; kind?: string } | null = null;
  // Cache-hit metrics (cache_creation_input_tokens / cache_read_input_tokens
  // among them) travel on the loop's own 'done' event — see agent-loop.ts.
  let usage: LLMUsage | undefined;

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
      approvedCall: params.approvedCall,
    })) {
      forwardEvent(
        session,
        ev,
        (r) => (finalReason = r),
        (e) => (lastError = e),
        (u) => {
          if (u) usage = u;
        },
      );
      if (finalReason) break; // loop's own done/plan_request/aborted terminus
    }
  } catch (err) {
    lastError = { error: err instanceof Error ? err.message : String(err), kind: 'internal' };
  }

  // Consolidated terminal frame. `usage` is included whenever the loop
  // reported any (even on an aborted/error turn — partial usage still cost
  // real tokens and is worth surfacing).
  const usageExtra = usage ? { usage } : {};
  if (finalReason === 'aborted') {
    finalize(session, 'aborted', usageExtra);
  } else if (lastError && !finalReason) {
    finalize(session, 'error', { error: lastError, ...usageExtra });
  } else {
    finalize(session, finalReason ?? 'end_turn', { ...(lastError ? { error: lastError } : {}), ...usageExtra });
  }
}

/** Translate one loop AgentEvent into buffered SSE frames + trace bookkeeping. */
function forwardEvent(
  session: ChatSession,
  ev: AgentEvent,
  setReason: (r: string) => void,
  setError: (e: { error: string; kind?: string }) => void,
  setUsage: (u: LLMUsage | undefined) => void,
): void {
  switch (ev.type) {
    case 'text_delta':
      session.assistantText += ev.text;
      emit(session, 'text_delta', { text: ev.text });
      break;
    case 'tool_call':
      {
        const input = redactBoundaryValue(ev.call.input) as Record<string, unknown>;
        session.toolTrace.push({ id: ev.call.id, name: ev.call.name, input });
        emit(session, 'tool_call', { id: ev.call.id, name: ev.call.name, input });
      }
      break;
    case 'tool_result': {
      const result = redactBoundaryValue(ev.result);
      const entry = session.toolTrace.find((t) => t.id === ev.id);
      if (entry) {
        entry.result = result;
        entry.isError = ev.isError;
      }
      emit(session, 'tool_result', {
        id: ev.id,
        name: ev.name,
        result,
        isError: ev.isError,
      });
      break;
    }
    case 'plan_request': {
      // C1: record the identity of the paused call so /chat/approve can bind the
      // approval to THIS exact {name, argsHash} rather than the whole turn.
      const hash = ev.argsHash ?? argsHash(ev.call.input);
      session.pendingPlanCall = { name: ev.call.name, argsHash: hash };
      const input = redactBoundaryValue(ev.call.input) as Record<string, unknown>;
      emit(session, 'plan_request', {
        id: ev.call.id,
        name: ev.call.name,
        input,
        source: ev.source,
        hint: ev.hint,
        args_hash: hash,
      });
      // Loop RETURNS after plan_request — the turn pauses pending approval.
      setReason('plan_request');
      break;
    }
    case 'done':
      setReason(ev.reason);
      setUsage(ev.usage);
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
  chatRoutesRegistered = false;
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Test hook: run the idle-TTL sweep at a given wall-clock time. */
export function __sweepSessions(now?: number): void {
  sweepSessions(now);
}

/** Test hook: number of live sessions. */
export function __sessionCount(): number {
  return sessions.size;
}

/** Introspection for tests: the port an app is listening on. */
export function addressPort(address: AddressInfo | string | null): number {
  if (address && typeof address === 'object') return address.port;
  throw new Error('server not listening on a TCP port');
}
