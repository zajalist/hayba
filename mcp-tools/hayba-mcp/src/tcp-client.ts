// mcp_server/src/tcp-client.ts
import { createConnection, Socket } from 'node:net';
import { EventEmitter } from 'node:events';

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

// ── Injectable types (also used in tests) ────────────────────────────────────
export type DelayFn = (ms: number) => Promise<void>;
export type DiscoverPortFn = () => number | null;

const defaultDelay: DelayFn = ms => new Promise(r => setTimeout(r, ms));

export class UETcpClient extends EventEmitter {
  private socket: Socket | null = null;
  private host: string;
  private port: number;
  private pendingRequests = new Map<string, {
    resolve: (value: TcpResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private receiveBuffer = Buffer.alloc(0);
  private requestCounter = 0;
  private connected = false;

  constructor(host = '127.0.0.1', port = 52342) {
    super();
    this.host = host;
    this.port = port;
    // Prevent unhandled 'error' event from crashing the process
    this.on('error', () => {});
  }

  /** Update the target port (used by ensureConnected on reconnect). */
  setPort(port: number): void {
    this.port = port;
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
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length >= 4) {
      const messageLength = this.receiveBuffer.readUInt32BE(0);
      if (messageLength === 0 || messageLength > 1024 * 1024) {
        this.receiveBuffer = Buffer.alloc(0);
        return;
      }

      if (this.receiveBuffer.length < 4 + messageLength) {
        return;
      }

      const messageBytes = this.receiveBuffer.subarray(4, 4 + messageLength);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + messageLength);

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

export function discoverPortFromInstanceRegistry(): number | null {
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

/** Resolve the target port, honouring the UE_TCP_PORT env override.
 *  Exported so tests can verify port-resolution logic in isolation. */
export function resolveTargetPort(
  discoverFn: DiscoverPortFn = discoverPortFromInstanceRegistry,
): number {
  const envPort = process.env.UE_TCP_PORT ? parseInt(process.env.UE_TCP_PORT, 10) : NaN;
  if (Number.isFinite(envPort)) return envPort;
  return discoverFn() ?? 52342;
}

/** Attempt a connect with bounded retries and exponential backoff.
 *  Exported so tests can exercise the retry/backoff logic with injected fakes,
 *  without needing a real socket. */
export async function connectWithBackoff(opts: {
  /** Single connection attempt — throw on failure. */
  attemptFn: () => Promise<void>;
  /** Number of attempts before giving up (default 3). */
  attempts?: number;
  /** Initial delay between retries in ms — doubles each retry (default 200). */
  initialMs?: number;
  /** Delay function — defaults to real setTimeout-based promise. */
  delayFn?: DelayFn;
}): Promise<void> {
  const { attemptFn, attempts = 3, initialMs = 200, delayFn = defaultDelay } = opts;
  let lastErr: Error | undefined;
  let waitMs = initialMs;
  for (let i = 0; i < attempts; i++) {
    try {
      await attemptFn();
      return;
    } catch (err) {
      lastErr = err as Error;
      if (i < attempts - 1) {
        await delayFn(waitMs);
        waitMs *= 2;
      }
    }
  }
  throw lastErr ?? new Error('Failed to connect after retries');
}

export function getUEClient(): UETcpClient {
  if (!client) {
    const port = resolveTargetPort();
    client = new UETcpClient('127.0.0.1', port);
  }
  return client;
}

export async function ensureConnected(
  // Optional injection seams — leave undefined in production:
  _discoverFn?: DiscoverPortFn,
  _delayFn?: DelayFn,
): Promise<UETcpClient> {
  const c = getUEClient();
  if (!c.isConnected()) {
    const discoverFn = _discoverFn ?? discoverPortFromInstanceRegistry;
    const delayFn = _delayFn ?? defaultDelay;
    await connectWithBackoff({
      attemptFn: async () => {
        // Re-discover port on every attempt so a restarted editor on a new
        // port is found automatically. UE_TCP_PORT env override stays authoritative.
        const port = resolveTargetPort(discoverFn);
        c.setPort(port);
        await c.connect();
      },
      delayFn,
    });
  }
  return c;
}

export interface AwaitResponsiveOpts {
  /** Total budget to wait for the port to become responsive (default 30 s). */
  timeoutMs?: number;
  /** Delay between probes (default 1 s). */
  intervalMs?: number;
  /** Per-probe send timeout (default 2 s) — a lightweight `ping`. */
  probeTimeoutMs?: number;
  /** Injected connect+ping for tests. Returns true if the port answered. */
  probeFn?: () => Promise<boolean>;
  /** Delay function — defaults to real setTimeout-based promise. */
  delayFn?: DelayFn;
  /** Clock — defaults to Date.now. */
  now?: () => number;
}

/**
 * Pre-flight gate for heavy ops: poll the plugin TCP port with a lightweight
 * `ping` until it answers or the budget expires. Returns true once the editor
 * is responsive, false if it never settled within `timeoutMs`.
 *
 * This is an OPT-IN utility — scripts/tools call it to wait for a busy editor
 * to settle before firing another heavy op into a closed port. It is NOT wired
 * into executeCommand's default path.
 */
export async function awaitEditorResponsive(opts: AwaitResponsiveOpts = {}): Promise<boolean> {
  const {
    timeoutMs = 30_000,
    intervalMs = 1_000,
    probeTimeoutMs = 2_000,
    delayFn = defaultDelay,
    now = Date.now,
  } = opts;

  const probeFn = opts.probeFn ?? (async () => {
    try {
      const c = await ensureConnected();
      const resp = await c.send('ping', {}, probeTimeoutMs);
      return resp.ok;
    } catch {
      return false;
    }
  });

  const deadline = now() + timeoutMs;
  // Always probe at least once, even for a zero/negative budget.
  for (;;) {
    if (await probeFn()) return true;
    if (now() >= deadline) return false;
    await delayFn(intervalMs);
  }
}

/** Reset the module-level singleton — for testing only. */
export function _resetClientForTesting(): void {
  client = null;
}
