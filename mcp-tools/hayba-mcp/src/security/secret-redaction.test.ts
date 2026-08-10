import { describe, expect, it, vi } from 'vitest';
import {
  installConsoleSecretRedaction,
  installExpressJsonRedaction,
  redactBoundaryValue,
  redactMcpResult,
  redactSecrets,
  redactThrown,
} from './secret-redaction.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.dGVzdHNpZ25hdHVyZQ';

describe('bounded central secret redaction', () => {
  it('masks mixed-case, snake, camel, and concatenated secret keys', () => {
    const original = {
      apiKey: 'SENTINEL_API',
      ACCESS_TOKEN: 'SENTINEL_ACCESS',
      clientSecret: 'SENTINEL_CLIENT',
      SECRETKEY: 'SENTINEL_SECRET',
      ApiAccessToken: 'SENTINEL_CONCAT',
      authorization: { scheme: 'Bearer', value: 'SENTINEL_AUTH' },
    };
    const result = redactSecrets(original);
    const serialized = JSON.stringify(result.value);
    for (const sentinel of Object.values(original).filter((v): v is string => typeof v === 'string')) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain('SENTINEL_AUTH');
    expect(result.summary.categories).toEqual(expect.arrayContaining(['api_key', 'authorization', 'credential', 'token']));
    expect(original.apiKey).toBe('SENTINEL_API');
  });

  it('preserves false-positive vocabulary and harmless token metrics', () => {
    const safe = {
      token_count: 42,
      TOKENCOUNT: 43,
      tokenizer: 'sentencepiece',
      passwordless: true,
      secretStatus: 'absent',
      authorization_error: 'none',
      credential_present: false,
      apiKeyName: 'OPENAI_API_KEY',
    };
    const result = redactSecrets(safe);
    expect(result.value).toBe(safe);
    expect(result.summary.applied).toBe(false);
  });

  it('masks bearer, JWT, provider keys, assignments, headers, URL credentials and query secrets', () => {
    const prose = [
      'Authorization: Bearer SENTINEL_BEARER_123456',
      `jwt=${JWT}`,
      'OPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
      'X-API-Key: SENTINEL_HEADER_123456',
      'https://user:SENTINEL_PASSWORD@example.test/path?token=SENTINEL_QUERY&safe=yes',
    ].join('\n');
    const result = redactSecrets(prose);
    expect(result.value).not.toContain('SENTINEL');
    expect(result.value).not.toContain(JWT);
    expect(result.value).toContain('safe=yes');
    expect(result.summary.categories).toEqual(expect.arrayContaining([
      'bearer', 'credential', 'password', 'provider_key', 'token', 'url_query',
    ]));

    const veryLong = redactSecrets(`Bearer ${'S'.repeat(10_000)}`);
    expect(veryLong.value).toBe('[REDACTED:bearer]');
    expect(veryLong.value).not.toContain('SSSS');
  });

  it('accepts only exact machine markers and rescans attacker-controlled marker prefixes', () => {
    const hostile = {
      direct: '[REDACTED:token] Bearer SENTINEL_MARKER_BEARER_123456',
      prefixed: 'prefix [TRUNCATED:depth] token=SENTINEL_MARKER_TOKEN',
      apiKey: '[REDACTED:token] SENTINEL_SECRET_KEY_BYPASS',
    };
    const once = redactSecrets(hostile);
    const twice = redactSecrets(once.value);
    expect(JSON.stringify(once.value)).not.toContain('SENTINEL');
    expect((once.value as typeof hostile).direct).toContain('[REDACTED:token]');
    expect((once.value as typeof hostile).direct).toContain('[REDACTED:bearer]');
    expect((once.value as typeof hostile).apiKey).toBe('[REDACTED:api_key]');
    expect(twice.value).toBe(once.value);
  });

  it('replaces secret-bearing property names with collision-safe deterministic placeholders', () => {
    const providerKey = 'sk-1234567890abcdefghijklmnop';
    const queryKey = 'https://example.test/callback?token=SENTINEL_KEY_QUERY';
    const bearerKey = 'Authorization: Bearer SENTINEL_KEY_BEARER_123456';
    const hostile = JSON.parse(JSON.stringify({
      [providerKey]: 1,
      [queryKey]: 2,
      [bearerKey]: 3,
      _redacted_key_provider_key_0: 'collision remains safe',
      __proto__: 'safe prototype spelling',
      token_count: 4,
    }));
    Object.defineProperty(hostile, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'safe prototype spelling',
    });

    const first = redactSecrets(hostile);
    const second = redactSecrets(hostile);
    const serialized = JSON.stringify(first.value);
    expect(serialized).not.toContain(providerKey);
    expect(serialized).not.toContain('SENTINEL_KEY');
    expect(Object.keys(first.value)).toEqual(Object.keys(second.value));
    expect(Object.keys(first.value)).toEqual(expect.arrayContaining([
      '_redacted_key_provider_key_0_1',
      '_redacted_key_url_query_1',
      '_redacted_key_bearer_2',
      '_redacted_key_provider_key_0',
      '__proto__',
      'token_count',
    ]));
    expect(first.summary.categories).toEqual(expect.arrayContaining(['bearer', 'provider_key', 'url_query']));
    expect(Object.prototype.hasOwnProperty.call(first.value, '__proto__')).toBe(true);
  });

  it('masks private-key blocks without deleting surrounding recovery text', () => {
    const text = 'Recovery: rotate this key\n-----BEGIN PRIVATE KEY-----\nSENTINEL_PRIVATE\n-----END PRIVATE KEY-----\nThen retry safely.';
    const result = redactSecrets(text);
    expect(result.value).not.toContain('SENTINEL_PRIVATE');
    expect(result.value).toContain('Recovery: rotate this key');
    expect(result.value).toContain('Then retry safely.');
  });

  it('handles prototype keys without prototype pollution', () => {
    const hostile = JSON.parse('{"__proto__":{"apiKey":"SENTINEL_PROTO"},"constructor":{"token":"SENTINEL_CTOR"},"prototype":{"password":"SENTINEL_PASS"}}');
    const result = redactSecrets(hostile);
    expect(JSON.stringify(result.value)).not.toContain('SENTINEL');
    expect(Object.prototype).not.toHaveProperty('apiKey');
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
  });

  it('never invokes hostile getters and fails closed on proxy traversal traps', () => {
    const getter = vi.fn(() => { throw new Error('SENTINEL_GETTER_EXCEPTION'); });
    const hostile: Record<string, unknown> = { safe: 'preserved' };
    Object.defineProperty(hostile, 'apiKey', { enumerable: true, get: getter });
    const getterResult = redactSecrets(hostile);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(getterResult.value)).not.toContain('SENTINEL');
    expect((getterResult.value as Record<string, unknown>).apiKey).toBe('[REDACTED:api_key]');

    const proxy = new Proxy({}, {
      ownKeys() { throw new Error('SENTINEL_PROXY_EXCEPTION'); },
    });
    const proxyResult = redactSecrets(proxy);
    expect(proxyResult.value).toBe('[TRUNCATED:accessor]');
    expect(proxyResult.summary.truncation_reasons).toContain('accessor');
  });

  it('fails closed on cycles, depth, node, array, object-key, and text budgets', () => {
    const cycle: Record<string, unknown> = { safe: true };
    cycle.self = cycle;
    const result = redactSecrets({
      cycle,
      deep: { a: { b: { c: { apiKey: 'SENTINEL_DEEP' } } } },
      array: Array.from({ length: 20 }, (_, i) => i),
      object: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])),
      prose: 'x'.repeat(200),
    }, {
      maxDepth: 3,
      maxNodes: 50,
      maxArrayItems: 4,
      maxObjectKeys: 6,
      maxKeyChars: 20,
      maxStringChars: 32,
      maxTotalStringChars: 64,
    });
    expect(() => JSON.stringify(result.value)).not.toThrow();
    expect(result.summary.truncated).toBe(true);
    expect(result.summary.truncation_reasons).toEqual(expect.arrayContaining(['array_items', 'cycle', 'depth', 'object_keys', 'string_chars']));
    expect(JSON.stringify(result.value)).not.toContain('SENTINEL_DEEP');
  });

  it('exposes truncation as a machine fact at object and array boundaries', () => {
    const object = redactBoundaryValue({ prose: 'x'.repeat(70_000) }) as Record<string, unknown>;
    expect(object._security_redaction).toMatchObject({ truncated: true });
    const array = redactBoundaryValue(Array.from({ length: 300 }, (_, i) => i)) as unknown[];
    expect(array.at(-1)).toMatchObject({ _security_redaction: { truncated: true } });
    expect(array.length).toBeLessThanOrEqual(256);
  });

  it('prioritizes errors and mandatory recovery when an object exceeds its key budget', () => {
    const payload = {
      ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`filler_${i}`, i])),
      error: 'A bounded but useful error',
      mandatory_recovery: 'Reconnect and retry with the same key.',
    };
    const result = redactSecrets(payload, { maxObjectKeys: 8 });
    expect(result.value).toMatchObject({
      error: 'A bounded but useful error',
      mandatory_recovery: 'Reconnect and retry with the same key.',
    });
    expect(result.summary.truncated).toBe(true);
  });

  it('preserves binary, base64, and image/audio content unless the key itself is secret', () => {
    const binary = Buffer.from('Bearer SENTINEL_BINARY');
    const payload = {
      png_base64: 'Bearer SENTINEL_BASE64',
      artifact_path: '/Saved/SENTINEL_ARTIFACT.png',
      image: { type: 'image', data: 'Bearer SENTINEL_IMAGE_DATA', mimeType: 'image/png' },
      binary,
      secret_base64: 'SENTINEL_SECRET_BASE64',
    };
    const result = redactSecrets(payload);
    expect((result.value as typeof payload).png_base64).toBe(payload.png_base64);
    expect((result.value as typeof payload).artifact_path).toBe(payload.artifact_path);
    expect((result.value as typeof payload).image.data).toBe(payload.image.data);
    expect((result.value as typeof payload).binary).toBe(binary);
    expect(JSON.stringify(result.value)).not.toContain('SENTINEL_SECRET_BASE64');
  });

  it('redacts nested JSON text in MCP content, annotates `_meta`, and is idempotent', () => {
    const original = {
      content: [{ type: 'text', text: JSON.stringify({ error: 'apiKey=SENTINEL_MCP', mandatory_recovery: 'rotate and retry' }) }],
      isError: true,
    };
    const once = redactMcpResult(original) as typeof original & { _meta?: Record<string, unknown> };
    const twice = redactMcpResult(once);
    expect(JSON.stringify(once)).not.toContain('SENTINEL_MCP');
    expect(JSON.stringify(once)).toContain('mandatory_recovery');
    expect(once._meta?.['hayba/security_redaction']).toMatchObject({ applied: true });
    expect(twice).toBe(once);
    expect(original.content[0]!.text).toContain('SENTINEL_MCP');
  });

  it('keeps a safe payload byte-for-byte and reference-identical', () => {
    const safe = { ok: true, token_count: 7, warnings: ['Nothing sensitive'], nested: { value: 4 } };
    const result = redactSecrets(safe);
    expect(result.value).toBe(safe);
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(safe));
    expect(result.summary).toMatchObject({ applied: false, truncated: false });
  });

  it('bounds hostile prose before regex matching', () => {
    const hostile = `${'a'.repeat(1_000_000)} Authorization: Bearer SENTINEL_TOO_LATE`;
    const started = performance.now();
    const result = redactSecrets(hostile, { maxStringChars: 2_048, maxTotalStringChars: 2_048 });
    expect(result.value.length).toBeLessThan(2_100);
    expect(result.summary.truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('redacts thrown Error messages, stacks, and enumerable detail without mutating the source', () => {
    const error = Object.assign(new Error('Authorization: Bearer SENTINEL_ERROR_12345'), {
      detail: { apiKey: 'SENTINEL_DETAIL' },
    });
    const safe = redactThrown(error) as Error & { detail: unknown };
    expect(JSON.stringify({ message: safe.message, stack: safe.stack, detail: safe.detail })).not.toContain('SENTINEL');
    expect(error.message).toContain('SENTINEL_ERROR');

    const detailOnly = Object.assign(new Error('safe outer message'), {
      detail: { accessToken: 'SENTINEL_DETAIL_ONLY' },
    });
    const safeDetailOnly = redactThrown(detailOnly) as Error & { detail: unknown };
    expect(JSON.stringify(safeDetailOnly.detail)).not.toContain('SENTINEL_DETAIL_ONLY');
    expect(safeDetailOnly.message).toBe('safe outer message');

    const caused = new Error('outer', { cause: new Error('token=SENTINEL_CAUSE') });
    const safeCaused = redactThrown(caused) as Error;
    expect(String((safeCaused.cause as Error).message)).not.toContain('SENTINEL_CAUSE');

    const detailGetter = vi.fn(() => { throw new Error('SENTINEL_ERROR_GETTER'); });
    const hostile = new Error('safe message');
    Object.defineProperty(hostile, 'detail', { enumerable: true, get: detailGetter });
    const safeHostile = redactThrown(hostile) as Error & { detail: unknown };
    expect(detailGetter).not.toHaveBeenCalled();
    expect(safeHostile.detail).toBe('[TRUNCATED:accessor]');
  });

  it('console installation is exactly once and sanitizes structured arguments', () => {
    const original = console.error;
    const sink = vi.fn();
    console.error = sink;
    try {
      installConsoleSecretRedaction();
      const wrapped = console.error;
      installConsoleSecretRedaction();
      expect(console.error).toBe(wrapped);
      console.error('apiKey=SENTINEL_LOG', { authorization: 'SENTINEL_STRUCTURED' });
      expect(JSON.stringify(sink.mock.calls)).not.toContain('SENTINEL');
    } finally {
      console.error = original;
    }
  });

  it('wraps overlapping Express JSON middleware exactly once', () => {
    const middleware: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const app = {
      use: vi.fn((...args: unknown[]) => {
        middleware.push(args.at(-1) as (req: unknown, res: unknown, next: () => void) => void);
      }),
    };
    installExpressJsonRedaction(app as never);
    installExpressJsonRedaction(app as never, '/chat');
    const sink = vi.fn((body: unknown) => body);
    const response = { json: sink };
    middleware[0]!({}, response, () => {});
    const once = response.json;
    middleware[1]!({}, response, () => {});
    expect(response.json).toBe(once);
    response.json({ apiKey: 'SENTINEL_EXPRESS' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sink.mock.calls)).not.toContain('SENTINEL_EXPRESS');
  });
});
