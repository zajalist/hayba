import type { SocketLike } from './brain-session.js';

type L = (ev: { data?: unknown }) => void;
export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private ls: Record<string, L[]> = {};
  addEventListener(t: 'open' | 'message' | 'close' | 'error', l: L) { (this.ls[t] ??= []).push(l); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.emit('close', {}); }
  // test drivers
  open() { this.readyState = 1; this.emit('open', {}); }
  push(frame: Record<string, unknown>) { this.emit('message', { data: JSON.stringify({ v: 1, session_id: 's-1', ...frame }) }); }
  drop() { this.readyState = 3; this.emit('close', {}); }
  private emit(t: string, ev: { data?: unknown }) { for (const l of this.ls[t] ?? []) l(ev); }
}
export const baseOpts = (sockets: FakeSocket[]) => ({
  url: 'ws://brain.test',
  clientVersion: '1.0.0',
  getAccessToken: async () => 'jwt',
  hello: {
    manifest: [],
    permissions: { 'tools.execute': true, 'facts.vision': false, 'facts.scene': false, python_run: false },
    llm: { mode: 'subscription' as const },
  },
  socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  backoffMs: [1, 1, 1] as const,
  openTimeoutMs: 200,
});
