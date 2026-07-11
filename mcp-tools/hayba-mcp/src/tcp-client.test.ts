import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  UETcpClient,
  connectWithBackoff,
  resolveTargetPort,
  ensureConnected,
  awaitEditorResponsive,
  _resetClientForTesting,
} from './tcp-client.js';

describe('awaitEditorResponsive', () => {
  const noDelay = async () => {};

  it('returns true immediately when the first probe answers', async () => {
    let probes = 0;
    const ok = await awaitEditorResponsive({
      probeFn: async () => { probes++; return true; },
      delayFn: noDelay,
    });
    expect(ok).toBe(true);
    expect(probes).toBe(1);
  });

  it('polls until the port becomes responsive', async () => {
    let probes = 0;
    const ok = await awaitEditorResponsive({
      probeFn: async () => { probes++; return probes >= 3; },
      delayFn: noDelay,
      intervalMs: 1,
      timeoutMs: 10_000,
      now: () => 0, // never exhaust the budget
    });
    expect(ok).toBe(true);
    expect(probes).toBe(3);
  });

  it('returns false when the budget expires before the port answers', async () => {
    let t = 0;
    const ok = await awaitEditorResponsive({
      probeFn: async () => false,
      delayFn: noDelay,
      intervalMs: 1,
      timeoutMs: 5,
      now: () => (t += 10), // jump past the deadline after the first probe
    });
    expect(ok).toBe(false);
  });
});

// ── Existing baseline tests ───────────────────────────────────────────────────

describe('UETcpClient', () => {
  it('should create a client with default host/port', () => {
    const client = new UETcpClient();
    expect(client.isConnected()).toBe(false);
  });

  it('should create a client with custom host/port', () => {
    const client = new UETcpClient('localhost', 9999);
    expect(client.isConnected()).toBe(false);
  });

  it('should reject send when not connected', async () => {
    const client = new UETcpClient();
    await expect(client.send('ping')).rejects.toThrow('Not connected');
  });
});

// ── (a) connectWithBackoff: retry with backoff then succeed ───────────────────

describe('connectWithBackoff', () => {
  it('succeeds on the first attempt without any delay', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };
    const attemptFn = vi.fn(async () => { /* success */ });

    await connectWithBackoff({ attemptFn, delayFn });

    expect(attemptFn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('(a) retries on failure and succeeds on the third attempt with exponential backoff', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };

    let callCount = 0;
    const attemptFn = vi.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error('connection refused');
    });

    await connectWithBackoff({ attemptFn, delayFn });

    // 3 attempts (fails on 1 + 2, succeeds on 3)
    expect(attemptFn).toHaveBeenCalledTimes(3);
    // 2 delays: 200ms then 400ms
    expect(delays).toEqual([200, 400]);
  });

  it('throws the last error after all attempts are exhausted', async () => {
    const delayFn = async (_ms: number) => { /* instant */ };
    const attemptFn = vi.fn(async () => { throw new Error('refused'); });

    await expect(
      connectWithBackoff({ attemptFn, delayFn, attempts: 3 }),
    ).rejects.toThrow('refused');

    expect(attemptFn).toHaveBeenCalledTimes(3);
  });

  it('respects a custom attempts count and initialMs', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };

    let callCount = 0;
    const attemptFn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) throw new Error('fail');
    });

    await connectWithBackoff({ attemptFn, delayFn, attempts: 4, initialMs: 100 });

    expect(attemptFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
  });

  it('no delay after the final failing attempt', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };
    const attemptFn = vi.fn(async () => { throw new Error('always fail'); });

    await expect(
      connectWithBackoff({ attemptFn, delayFn, attempts: 3 }),
    ).rejects.toThrow();

    // 3 attempts → 2 delays (no delay after the last attempt)
    expect(delays).toHaveLength(2);
  });
});

// ── (b) resolveTargetPort: re-reads port from discovery fn ───────────────────

describe('resolveTargetPort', () => {
  afterEach(() => {
    delete process.env.UE_TCP_PORT;
  });

  it('(b) calls discoverFn when UE_TCP_PORT is not set, and returns discovered port', () => {
    delete process.env.UE_TCP_PORT;
    const discoverFn = vi.fn(() => 52400);

    const port = resolveTargetPort(discoverFn);

    expect(discoverFn).toHaveBeenCalledOnce();
    expect(port).toBe(52400);
  });

  it('falls back to 52342 when discovery returns null', () => {
    delete process.env.UE_TCP_PORT;
    const discoverFn = vi.fn(() => null);

    const port = resolveTargetPort(discoverFn);

    expect(port).toBe(52342);
  });

  it('(c) UE_TCP_PORT env override wins over discovery', () => {
    process.env.UE_TCP_PORT = '55000';
    const discoverFn = vi.fn(() => 52400);

    const port = resolveTargetPort(discoverFn);

    expect(port).toBe(55000);
    // Discovery should NOT be called when env override is set
    expect(discoverFn).not.toHaveBeenCalled();
  });

  it('(c) UE_TCP_PORT overrides the 52342 default too', () => {
    process.env.UE_TCP_PORT = '60000';
    const discoverFn = vi.fn(() => null);

    const port = resolveTargetPort(discoverFn);

    expect(port).toBe(60000);
    expect(discoverFn).not.toHaveBeenCalled();
  });
});

// ── ensureConnected integration: port re-discovery wired in ──────────────────

describe('ensureConnected', () => {
  afterEach(() => {
    _resetClientForTesting();
    delete process.env.UE_TCP_PORT;
  });

  it('calls discoverFn during connect and sets the discovered port', async () => {
    _resetClientForTesting();

    const discoverFn = vi.fn(() => 52500);
    const delayFn = async (_ms: number) => { /* instant */ };

    // Intercept getUEClient()'s client.connect() to avoid a real socket.
    // We monkey-patch the prototype just for this test.
    const originalConnect = UETcpClient.prototype.connect;
    let capturedPort: number | null = null;
    UETcpClient.prototype.connect = async function (this: UETcpClient) {
      capturedPort = (this as unknown as Record<string, unknown>)['port'] as number;
      // Simulate a successful connection by marking the internal state.
      (this as unknown as Record<string, unknown>)['connected'] = true;
    };

    try {
      await ensureConnected(discoverFn, delayFn);
      expect(discoverFn).toHaveBeenCalled();
      expect(capturedPort).toBe(52500);
    } finally {
      UETcpClient.prototype.connect = originalConnect;
    }
  });

  it('UE_TCP_PORT overrides discovery even inside ensureConnected', async () => {
    _resetClientForTesting();
    process.env.UE_TCP_PORT = '59999';

    const discoverFn = vi.fn(() => 52500);
    const delayFn = async (_ms: number) => { /* instant */ };

    const originalConnect = UETcpClient.prototype.connect;
    let capturedPort: number | null = null;
    UETcpClient.prototype.connect = async function (this: UETcpClient) {
      capturedPort = (this as unknown as Record<string, unknown>)['port'] as number;
      (this as unknown as Record<string, unknown>)['connected'] = true;
    };

    try {
      await ensureConnected(discoverFn, delayFn);
      expect(capturedPort).toBe(59999);
      expect(discoverFn).not.toHaveBeenCalled();
    } finally {
      UETcpClient.prototype.connect = originalConnect;
    }
  });

  it('retries connect via backoff and returns client on eventual success', async () => {
    _resetClientForTesting();

    const discoverFn = vi.fn(() => 52342);
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };

    let connectAttempts = 0;
    const originalConnect = UETcpClient.prototype.connect;
    UETcpClient.prototype.connect = async function () {
      connectAttempts++;
      if (connectAttempts < 3) throw new Error('ECONNREFUSED');
      (this as unknown as Record<string, unknown>)['connected'] = true;
    };

    try {
      const result = await ensureConnected(discoverFn, delayFn);
      expect(result).toBeDefined();
      expect(connectAttempts).toBe(3);
      expect(delays).toEqual([200, 400]);
    } finally {
      UETcpClient.prototype.connect = originalConnect;
    }
  });
});
