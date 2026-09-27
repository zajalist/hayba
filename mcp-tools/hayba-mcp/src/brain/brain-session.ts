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
}
export type OpenResult =
  | { ok: true; welcome: Welcome }
  | { ok: false; reason: ProUnavailableReason | 'upgrade_required'; message: string };

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const OPEN = 1;

export class BrainSession {
  private socket?: SocketLike;
  private outSeq = 0;
  private lastInSeq = 0;
  private pending: string[] = [];
  private inbox: Frame[] = [];
  private waiter?: (f: Frame | null) => void;
  private closed = false;
  private attempt = 0;
  private established = false;

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
        this.sendNow({
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
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, session_id: this.sessionId, seq: ++this.outSeq, ...body });
    if (this.socket?.readyState === OPEN && this.established) this.socket.send(frame);
    else this.pending.push(frame);
  }

  async *frames(): AsyncGenerator<Frame> {
    while (true) {
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

  private sendNow(body: Outbound<Frame>): void {
    this.socket?.send(JSON.stringify({ v: PROTOCOL_VERSION, session_id: this.sessionId, seq: ++this.outSeq, ...body }));
  }

  private connect(onOpen: () => void, intercept?: (f: Frame) => boolean): void {
    const socket = (this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(this.opts.url);
    this.socket = socket;
    socket.addEventListener('open', () => { this.attempt = 0; onOpen(); });
    socket.addEventListener('message', (ev) => {
      const parsed = parseFrame(String(ev.data));
      if (!parsed.ok) return; // malformed brain frames are ignored, never executed
      const f = parsed.frame;
      if (f.seq <= this.lastInSeq) return; // replay duplicate
      this.lastInSeq = f.seq;
      if (intercept?.(f)) return;
      this.deliver(f);
    });
    socket.addEventListener('close', () => {
      if (this.closed || !this.established) return;
      const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
      const delay = backoff[Math.min(this.attempt++, backoff.length - 1)];
      setTimeout(() => void this.reconnect(), delay);
    });
    socket.addEventListener('error', () => { /* close follows */ });
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    const token = await this.opts.getAccessToken();
    this.connect(() => {
      this.sendNow({ type: 'resume', access_token: token, last_seq: this.lastInSeq });
      for (const frame of this.pending.splice(0)) this.socket?.send(frame);
    });
  }

  private deliver(f: Frame | null): void {
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(f); }
    else if (f) this.inbox.push(f);
  }
}
