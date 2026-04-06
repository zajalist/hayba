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

export function getUEClient(): UETcpClient {
  if (!client) {
    const port = parseInt(process.env.UE_TCP_PORT || '52342', 10);
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
