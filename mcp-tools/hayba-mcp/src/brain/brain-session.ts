import {
  PROTOCOL_VERSION, parseFrame,
  type Frame, type Outbound, type Welcome, type ToolManifestEntry, type Permissions, type LlmMode, type ProUnavailableReason,
} from '@hayba/brain-protocol';
import { shapeToolResult } from './hands-guard.js';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown }) => void): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface BrainSessionOptions {
  url: string;
  clientVersion: string;
  getAccessToken: () => Promise<string>;
  hello: { manifest: ToolManifestEntry[]; permissions: Permissions; llm: LlmMode; ue_version?: string };
  socketFactory?: SocketFactory;
  backoffMs?: readonly number[];
  openTimeoutMs?: number;
  /** How long to keep reconnecting after a drop before giving up (the brain's resume window). */
  resumeWindowMs?: number;
  /** Safety-net ceiling on how long turn-discard mode can stay on if `done` never arrives. */
  discardTimeoutMs?: number;
  /** A reconnect socket that hasn't been ACKed (opened + resume accepted) by then is abandoned. */
  connectTimeoutMs?: number;
  /** Keep-alive ping cadence while connected (tunnels close idle sockets after ~100 s). */
  pingIntervalMs?: number;
}
export type OpenResult =
  | { ok: true; welcome: Welcome }
  | { ok: false; reason: ProUnavailableReason | 'upgrade_required'; message: string };

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const DEFAULT_RESUME_WINDOW_MS = 600_000;
const DEFAULT_DISCARD_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const OPEN = 1;

/** Frames that answer a hello/resume; on an un-ACKed socket they bypass the seq filter. */
type HandshakeFrame = Extract<Frame, { type: 'welcome' | 'pro_unavailable' | 'upgrade_required' }>;
function isHandshakeFrame(f: Frame): f is HandshakeFrame {
  return f.type === 'welcome' || f.type === 'pro_unavailable' || f.type === 'upgrade_required';
}

export class BrainSession {
  private socket?: SocketLike;
  private outSeq = 0;
  private lastInSeq = 0;
  /** Outbound bodies not yet written to a live socket; stamped with `seq` only at write time. */
  private pending: Array<Outbound<Frame>> = [];
  private inbox: Frame[] = [];
  private waiter?: (f: Frame | null) => void;
  /** True once a null (end-of-stream) has been delivered with no waiter around to see it. */
  private ended = false;
  private closed = false;
  private attempt = 0;
  private established = false;
  /** Set when a post-welcome socket drops; cleared once reconnected. Drives the give-up deadline. */
  private disconnectedAt?: number;
  /** True while absorbing a locally-cancelled turn's remaining frames (see `cancelTurn`). */
  private discardingTurn = false;
  private discardTimer?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  /**
   * tool_results already sent for the turn in flight. A result written to a socket
   * that was dying is lost with it; these are re-sent after an ACKed resume (the
   * brain dedupes by id) and forgotten once the turn reaches `done`.
   */
  private sentToolResults = new Map<string, Outbound<Frame>>();

  constructor(readonly sessionId: string, private readonly opts: BrainSessionOptions) {}

  /**
   * False once this session can never carry another turn: it was closed locally,
   * gave up after its resume window, or its frame stream ended. A caller holding
   * a dead session must drop it and open a fresh one.
   */
  isAlive(): boolean {
    return !this.closed && !this.ended;
  }

  async open(): Promise<OpenResult> {
    const token = await this.opts.getAccessToken();
    return new Promise<OpenResult>((resolve) => {
      const timer = setTimeout(() => {
        this.closed = true;
        this.socket?.close();
        resolve({ ok: false, reason: 'unreachable', message: 'Hayba Pro did not answer in time.' });
      }, this.opts.openTimeoutMs ?? 10_000);
      const settle = (r: OpenResult) => { clearTimeout(timer); resolve(r); };
      this.connect({
        initial: true,
        onOpen: () => this.write({
          type: 'hello', access_token: token, client_version: this.opts.clientVersion, ...this.opts.hello,
        }),
        onHandshake: (f) => {
          if (f.type === 'welcome') { this.established = true; this.startPinging(); settle({ ok: true, welcome: f }); return; }
          this.closed = true; this.socket?.close();
          settle(f.type === 'pro_unavailable'
            ? { ok: false, reason: f.reason, message: f.message }
            : { ok: false, reason: 'upgrade_required', message: `Update Hayba to use Pro: ${f.download_url}` });
        },
      });
    });
  }

  /** Stamp the envelope and send, or queue until the socket is back. */
  send<T extends Frame>(body: Outbound<T>): void {
    if (body.type === 'tool_result') this.sentToolResults.set(body.id, body);
    if (this.socket?.readyState === OPEN && this.established) this.write(body);
    else this.pending.push(body);
  }

  /**
   * The local caller has abandoned the in-flight turn (e.g. it aborted while this
   * session was disconnected or silent). Two things must happen so the session
   * stays usable for the NEXT turn:
   *  - any `frames()` consumer currently parked waiting for the next frame is
   *    released now (with `null`, ending its iteration) instead of being left to
   *    accidentally swallow whatever the brain sends next;
   *  - this turn's remaining frames (its reply to `cancel`, straggling events,
   *    a stray tool_call) must never reach the next `frames()` call. They are
   *    silently absorbed — a `tool_call` gets an immediate cancelled result so
   *    the brain isn't left waiting — until the brain's own terminal for this
   *    turn arrives.
   */
  cancelTurn(): void {
    this.discardingTurn = true;
    if (this.discardTimer) clearTimeout(this.discardTimer);
    // Safety net: if `done` never arrives (a brain bug, or a frame lost to a
    // race we didn't anticipate), don't wedge this session shut forever.
    this.discardTimer = setTimeout(() => this.stopDiscarding(), this.opts.discardTimeoutMs ?? DEFAULT_DISCARD_TIMEOUT_MS);
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(null); }
    const queued = this.inbox.splice(0);
    for (const f of queued) {
      if (!this.absorbDiscardedFrame(f)) this.inbox.push(f);
    }
  }

  private stopDiscarding(): void {
    this.discardingTurn = false;
    if (this.discardTimer) { clearTimeout(this.discardTimer); this.discardTimer = undefined; }
  }

  /** Returns true if `f` belonged to the cancelled turn and was absorbed (never to be delivered). */
  private absorbDiscardedFrame(f: Frame): boolean {
    // A fresh (non-resumed) welcome means a brand-new session handshake — any
    // discard state left over from a prior turn is meaningless now.
    if (f.type === 'welcome' && !f.resumed) this.stopDiscarding();
    if (!this.discardingTurn) return false;
    if (f.type === 'tool_call') {
      const shaped = shapeToolResult({ error: 'cancelled' });
      this.send({ type: 'tool_result', id: f.id, ok: false, result: shaped.result, truncated: shaped.truncated });
      return true;
    }
    if (f.type === 'event') {
      // Absorbed unconditionally: a cancelled turn's activity_completed (or a
      // terminal error) doesn't by itself prove the brain is done talking about
      // it — `done` is the one frame that reliably closes out the exchange.
      return true;
    }
    if (f.type === 'done') {
      this.stopDiscarding();
      return true;
    }
    return false; // ping/pro_unavailable/upgrade_required/resume echoes are session-level, not turn-scoped
  }

  async *frames(): AsyncGenerator<Frame> {
    while (true) {
      if (this.inbox.length === 0 && this.ended) return;
      const f = this.inbox.shift() ?? (await new Promise<Frame | null>((r) => (this.waiter = r)));
      if (f === null) return;
      yield f;
    }
  }

  close(): void {
    this.closed = true;
    this.stopPinging();
    this.socket?.close(1000, 'client closed');
    this.deliver(null);
  }

  /** Stamps `seq` at the moment a frame is actually written, so wire order stays seq order. */
  private write(body: Outbound<Frame>): void {
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, session_id: this.sessionId, seq: ++this.outSeq, ...body });
    this.socket?.send(frame);
  }

  /**
   * Opens one socket. Each socket has its own handshake phase: until the brain
   * answers the hello/resume, a welcome/pro_unavailable/upgrade_required on it
   * goes to `onHandshake` WITHOUT the seq filter — the brain stamps rejections
   * with seq 1, which the filter would otherwise drop as a replay duplicate.
   * Frames from a socket that has since been replaced are ignored.
   */
  private connect(h: { initial: boolean; onOpen: () => void; onHandshake: (f: HandshakeFrame) => void }): void {
    const socket = (this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(this.opts.url);
    this.socket = socket;
    let acked = false;
    let finished = false;
    const onClose = () => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      if (socket !== this.socket) return;
      this.stopPinging();
      this.handleClose();
    };
    // A reconnect that never gets ACKed (stuck connecting, or opened but silent)
    // is abandoned so it counts toward the give-up deadline instead of hanging.
    // (The initial open has its own `openTimeoutMs`.)
    const connectTimer = h.initial ? undefined : setTimeout(() => {
      if (acked || finished) return;
      socket.close();
      onClose();
    }, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      if (socket === this.socket) h.onOpen();
    });
    socket.addEventListener('message', (ev) => {
      if (socket !== this.socket || finished) return;
      const parsed = parseFrame(String(ev.data));
      if (!parsed.ok) return; // malformed brain frames are ignored, never executed
      const f = parsed.frame;
      if (!acked && isHandshakeFrame(f)) {
        if (f.type === 'welcome') {
          acked = true;
          clearTimeout(connectTimer);
          this.lastInSeq = Math.max(this.lastInSeq, f.seq);
        }
        h.onHandshake(f);
        return;
      }
      if (f.seq <= this.lastInSeq) return; // replay duplicate
      this.lastInSeq = f.seq;
      if (f.type === 'ping') return; // keep-alive only
      if (f.type === 'done') this.sentToolResults.clear(); // the turn is over; nothing left to re-send
      if (this.absorbDiscardedFrame(f)) return;
      this.deliver(f);
    });
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', () => { /* close follows */ });
  }

  private startPinging(): void {
    this.stopPinging();
    this.pinger = setInterval(() => {
      if (this.socket?.readyState === OPEN && this.established && !this.closed) this.write({ type: 'ping' });
    }, this.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    (this.pinger as { unref?: () => void }).unref?.();
  }

  private stopPinging(): void {
    if (this.pinger) { clearInterval(this.pinger); this.pinger = undefined; }
  }

  private handleClose(): void {
    if (this.closed || !this.established) return;
    if (this.disconnectedAt === undefined) this.disconnectedAt = Date.now();
    this.scheduleReconnect();
  }

  private isPastResumeWindow(): boolean {
    const resumeWindowMs = this.opts.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
    return this.disconnectedAt !== undefined && Date.now() - this.disconnectedAt >= resumeWindowMs;
  }

  private scheduleReconnect(): void {
    if (this.isPastResumeWindow()) { this.giveUp(); return; }
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.attempt++, backoff.length - 1)];
    setTimeout(() => void this.reconnect(), delay);
  }

  /** The brain's resume window has elapsed with no reconnect; end the session like a brain outage. */
  private giveUp(): void {
    this.closed = true;
    this.stopPinging();
    this.deliver({
      type: 'pro_unavailable',
      v: PROTOCOL_VERSION,
      session_id: this.sessionId,
      seq: ++this.lastInSeq,
      reason: 'unreachable',
      message: 'Lost connection to Hayba Pro.',
    } satisfies Frame);
    this.deliver(null);
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    if (this.isPastResumeWindow()) { this.giveUp(); return; }
    let token: string;
    try {
      token = await this.opts.getAccessToken();
    } catch {
      // Token refresh failed; keep retrying on the same backoff/give-up schedule.
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return;
    this.connect({
      initial: false,
      onOpen: () => {
        this.write({ type: 'resume', access_token: token, last_seq: this.lastInSeq });
        // The brain handles frames strictly in order, so queued frames may follow the resume at once.
        for (const body of this.pending.splice(0)) this.write(body);
      },
      onHandshake: (f) => {
        if (f.type === 'welcome') {
          // Only an ACKed resume proves the brain still holds this session.
          this.attempt = 0;
          this.disconnectedAt = undefined;
          this.startPinging();
          for (const body of this.sentToolResults.values()) this.write(body);
          return;
        }
        // The brain no longer holds this session (restart, sweep) or needs a newer
        // client: end it and hand the terminal to the current turn. The next turn
        // opens a fresh session with a hello.
        this.closed = true;
        this.socket?.close();
        this.sentToolResults.clear();
        this.deliver(f);
        this.deliver(null);
      },
    });
  }

  private deliver(f: Frame | null): void {
    if (f === null) this.ended = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(f); }
    else if (f) this.inbox.push(f);
  }
}
