// mcp_server/src/tcp-client.ts
import { createConnection, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameDecoder } from './tcp-frame-decoder.js';

export interface TcpCommand {
  cmd: string;
  id: string;
  params: Record<string, unknown>;
}

export interface TcpResponse {
  id: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  /** Optional machine-readable failure code from the UE side. Set on plan-gate
   *  and tool-disabled rejections so the TS ToolExecutor can map them onto a
   *  UeToolError code without string-matching UE's `error` text. */
  code?: string;
}

export class UETcpClient extends EventEmitter {
  private socket: Socket | null = null;
  private host: string;
  private port: number;
  private pendingRequests = new Map<string, {
    resolve: (value: TcpResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private decoder = new FrameDecoder();
  private requestCounter = 0;
  private connected = false;

  constructor(host = '127.0.0.1', port = 52342) {
    super();
    this.host = host;
    this.port = port;
    // Prevent unhandled 'error' event from crashing the process
    this.on('error', () => {});
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host: this.host, port: this.port }, () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data: Buffer) => this.onData(data));
      this.socket.on('close', () => {
        this.connected = false;
        this.decoder.reset(); // drop any half-received frame so the next connection starts clean
        this.emit('disconnected');
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      });
      this.socket.on('error', (err: Error) => {
        if (!this.connected) reject(err);
        this.emit('error', err);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<TcpResponse> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to UE TCP server');
    }

    const id = `req_${++this.requestCounter}`;
    const command: TcpCommand = { cmd, id, params };
    const json = JSON.stringify(command);
    const payload = Buffer.from(json, 'utf-8');

    // Length-prefixed framing: 4-byte big-endian length + payload
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${cmd} (id: ${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }

  private onData(data: Buffer): void {
    // Framing lives in FrameDecoder; here we only parse + route payloads.
    for (const messageBytes of this.decoder.push(data)) {
      try {
        const response: TcpResponse = JSON.parse(messageBytes.toString('utf-8'));
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }
}

// Singleton instance for the MCP server
let client: UETcpClient | null = null;

function discoverPortFromInstanceRegistry(): number | null {
  // Initiative #3: UE writes Saved/HaybaMCP/instances/<pid>.json on startup.
  // Pick the most recently started live entry so the Node side connects to
  // whichever editor is currently running, regardless of port collision.
  try {
    // Lazy require to keep the cold path free of fs imports when env is set.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const cwd = process.cwd();
    // Walk up to 4 levels so we find Saved/ from a workspace dist location.
    for (let i = 0; i < 4; ++i) {
      const dir = path.resolve(cwd, '../'.repeat(i), 'Saved/HaybaMCP/instances');
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const entries = files.map(f => {
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
          return JSON.parse(raw) as { pid: number; port: number; started_at: string };
        } catch {
          return null;
        }
      }).filter((e): e is { pid: number; port: number; started_at: string } => e !== null);
      if (entries.length === 0) continue;
      // Most recently started wins.
      entries.sort((a, b) => b.started_at.localeCompare(a.started_at));
      return entries[0].port;
    }
  } catch {
    // Fall through to default.
  }
  return null;
}

export function getUEClient(): UETcpClient {
  if (!client) {
    const envPort = process.env.UE_TCP_PORT ? parseInt(process.env.UE_TCP_PORT, 10) : NaN;
    const port = Number.isFinite(envPort)
      ? envPort
      : (discoverPortFromInstanceRegistry() ?? 52342);
    client = new UETcpClient('127.0.0.1', port);
  }
  return client;
}

export async function ensureConnected(): Promise<UETcpClient> {
  const c = getUEClient();
  if (!c.isConnected()) {
    await c.connect();
  }
  return c;
}
