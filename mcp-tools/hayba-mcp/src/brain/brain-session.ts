import {
  PROTOCOL_VERSION, parseFrame,
  type Frame, type Outbound, type Welcome, type ToolManifestEntry, type Permissions, type LlmMode, type ProUnavailableReason,
} from '@hayba/brain-protocol';

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
}
export type OpenResult =
  | { ok: true; welcome: Welcome }
  | { ok: false; reason: ProUnavailableReason | 'upgrade_required'; message: string };

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const DEFAULT_RESUME_WINDOW_MS = 600_000;
const OPEN = 1;

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

  constructor(readonly sessionId: string, private readonly opts: BrainSessionOptions) {}

  async open(): Promise<OpenResult> {
    const token = await this.opts.getAccessToken();
    return new Promise<OpenResult>((resolve) => {
      const timer = setTimeout(() => {
        this.closed = true;
        this.socket?.close();
        resolve({ ok: false, reason: 'unreachable', message: 'Hayba Pro did not answer in time.' });
      }, this.opts.openTimeoutMs ?? 10_000);
      const settle = (r: OpenResult) => { clearTimeout(timer); resolve(r); };
      this.connect(() => {
        this.write({
          type: 'hello', access_token: token, client_version: this.opts.clientVersion, ...this.opts.hello,
        });
      }, (f) => {
        if (f.type === 'welcome') { this.established = true; settle({ ok: true, welcome: f }); return true; }
        if (f.type === 'pro_unavailable') { this.closed = true; this.socket?.close(); settle({ ok: false, reason: f.reason, message: f.message }); return true; }
        if (f.type === 'upgrade_required') {
          this.closed = true; this.socket?.close();
          settle({ ok: false, reason: 'upgrade_required', message: `Update Hayba to use Pro: ${f.download_url}` });
          return true;
        }
        return false;
      });
    });
  }

  /** Stamp the envelope and send, or queue until the socket is back. */
  send<T extends Frame>(body: Outbound<T>): void {
    if (this.socket?.readyState === OPEN && this.established) this.write(body);
    else this.pending.push(body);
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
    this.socket?.close(1000, 'client closed');
    this.deliver(null);
  }

  /** Stamps `seq` at the moment a frame is actually written, so wire order stays seq order. */
  private write(body: Outbound<Frame>): void {
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, session_id: this.sessionId, seq: ++this.outSeq, ...body });
    this.socket?.send(frame);
  }

  private connect(onOpen: () => void, intercept?: (f: Frame) => boolean): void {
    const socket = (this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(this.opts.url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.disconnectedAt = undefined;
      onOpen();
    });
    socket.addEventListener('message', (ev) => {
      const parsed = parseFrame(String(ev.data));
      if (!parsed.ok) return; // malformed brain frames are ignored, never executed
      const f = parsed.frame;
      if (f.seq <= this.lastInSeq) return; // replay duplicate
      this.lastInSeq = f.seq;
      if (intercept?.(f)) return;
      this.deliver(f);
    });
    socket.addEventListener('close', () => this.handleClose());
    socket.addEventListener('error', () => { /* close follows */ });
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
    this.connect(() => {
      this.write({ type: 'resume', access_token: token, last_seq: this.lastInSeq });
      for (const body of this.pending.splice(0)) this.write(body);
    });
  }

  private deliver(f: Frame | null): void {
    if (f === null) this.ended = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(f); }
    else if (f) this.inbox.push(f);
  }
}
