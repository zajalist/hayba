/**
 * BYOK LLM client with tool-calling + streaming.
 *
 * Restored from the removed commit ac46d40 (packages/hayba/src/agents/llm-client.ts):
 *   - LLMTool / LLMToolCall / LLMResponse (stopReason:'end_turn'|'tool_use'|'max_tokens')
 *   - complete()
 *
 * Extended for the chat copilot:
 *   - provider/model/baseURL/key resolved from providers.ts + an injected config
 *     object (never env-only; the key is never logged or echoed in errors/events)
 *   - stream() yielding one normalized event type for both wire protocols
 *   - typed LLMError mapping 401->auth / 429->rate_limit / network->network
 *   - dependency-injected SDK clients so tests pass FAKE Anthropic/OpenAI clients
 *
 * Two wire protocols, one normalized surface:
 *   - anthropic:      messages.create / messages.stream
 *   - openai (compat): chat.completions.create ({stream:true} for streaming)
 *   - mock:           deterministic in-process echo (offline dev + tests)
 */

import { redactSecrets } from '../security/secret-redaction.js';
import { getProvider, type ProviderProtocol } from './providers.js';

// ---------------------------------------------------------------------------
// Restored public shape (ac46d40) + extensions
// ---------------------------------------------------------------------------

/**
 * A structured content block. Anthropic maps these 1:1 to its native content
 * blocks; the OpenAI builder translates them into `tool_calls` / `tool` messages.
 */
export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LLMMessage {
  role: 'user' | 'assistant';
  /** Plain string (simple turns) or structured blocks (tool_use / tool_result). */
  content: string | LLMContentBlock[];
}

export interface LLMTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'content_filter' | 'unknown';

/**
 * Token accounting for one LLM call. `cacheCreationInputTokens` /
 * `cacheReadInputTokens` are Anthropic-specific (prompt caching); they stay
 * `undefined` for protocols/providers that don't report them, never `0` — a
 * real 0 vs "not reported" distinction matters for hit-rate metrics.
 */
export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  stopReason: LLMStopReason;
  usage?: LLMUsage;
}

/** One normalized event type for `stream()`; both protocols normalize into it. */
export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: LLMToolCall }
  | { type: 'done'; response: LLMResponse };

export type LLMErrorKind = 'auth' | 'rate_limit' | 'network' | 'api';

/** Typed error so the agent loop / UI can react. Never contains the API key. */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status?: number;
  constructor(kind: LLMErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.status = status;
  }
}

export interface LLMCompleteParams {
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  maxTokens?: number;
  /** Threaded into the underlying SDK request so the call is cancelled promptly. */
  signal?: AbortSignal;
}

export interface LLMClient {
  provider: string;
  model: string;
  protocol: ProviderProtocol;
  complete(params: LLMCompleteParams): Promise<LLMResponse>;
  stream(params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown>;
}

// ---------------------------------------------------------------------------
// Injected SDK client shapes (structural — real SDKs satisfy these)
// ---------------------------------------------------------------------------

/** Per-request options passed as the SDK's second argument (carries the signal). */
export interface LLMRequestOptions {
  signal?: AbortSignal;
}

export interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>, options?: LLMRequestOptions): Promise<unknown>;
    stream(params: Record<string, unknown>, options?: LLMRequestOptions): AsyncIterable<unknown>;
  };
}

export interface OpenAIClientLike {
  chat: {
    completions: {
      create(params: Record<string, unknown>, options?: LLMRequestOptions): Promise<unknown>;
    };
  };
}

export interface LLMClientDeps {
  /** Pre-built Anthropic client (tests inject a fake; prod builds one lazily). */
  anthropic?: AnthropicClientLike;
  /** Pre-built OpenAI-compat client. */
  openai?: OpenAIClientLike;
}

export interface LLMClientConfig {
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  /** Optional SDK request deadline. Primarily useful for local OpenAI-compatible providers. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Config resolution (catalog + injected config; env only as last-resort fallback)
// ---------------------------------------------------------------------------

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

interface ResolvedConfig {
  provider: string;
  protocol: ProviderProtocol;
  model: string;
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
}

function hasUnsafeBaseURLCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === '\\' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonicalize an OpenAI-compatible endpoint before giving it to the SDK.
 * A custom provider with no endpoint must fail closed: otherwise the OpenAI
 * SDK silently falls back to api.openai.com, which is an unsafe surprise for
 * a caller that selected a local provider.
 */
export function normalizeOpenAIBaseURL(raw: string, provider = 'OpenAI-compatible'): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new LLMError('api', `${provider} requires an explicit base URL`);
  }
  if (trimmed.length > 2_048 || hasUnsafeBaseURLCharacter(trimmed)) {
    throw new LLMError('api', `${provider} base URL is invalid`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LLMError('api', `${provider} base URL is invalid`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new LLMError('api', `${provider} base URL must be an HTTP(S) URL without credentials`);
  }
  if (url.search || url.hash) {
    throw new LLMError('api', `${provider} base URL must not contain a query string or fragment`);
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function resolveConfig(config: LLMClientConfig): ResolvedConfig {
  const entry = getProvider(config.provider);
  if (!entry) {
    throw new LLMError('api', `Unknown provider: ${config.provider}`);
  }
  const envKey = ENV_KEY_BY_PROVIDER[config.provider];
  const apiKey = config.apiKey ?? (envKey ? (process.env[envKey] ?? '') : '');
  const rawBaseURL = config.baseURL ?? entry.baseURLDefault;
  const baseURL = entry.protocol === 'openai' ? normalizeOpenAIBaseURL(rawBaseURL, entry.label) : rawBaseURL;
  if (
    config.timeoutMs !== undefined &&
    (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 10 * 60_000)
  ) {
    throw new LLMError('api', 'LLM timeoutMs must be an integer between 1 and 600000');
  }
  return {
    provider: entry.id,
    protocol: entry.protocol,
    model: config.model ?? entry.defaultModel,
    baseURL,
    apiKey,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Error mapping + key redaction
// ---------------------------------------------------------------------------

function redactDiagnostic(text: string, apiKey: string): string {
  // Exact replacement catches short/custom keys that do not look like a
  // provider key; the central bounded redactor catches Authorization headers,
  // URL credentials, and secret-looking fields in otherwise useful prose.
  const withoutConfiguredKey = apiKey ? text.split(apiKey).join('[REDACTED:api_key]') : text;
  return redactSecrets(withoutConfiguredKey, { maxStringChars: 2_048, maxTotalStringChars: 2_048 }).value;
}

function mapError(err: unknown, provider: string, apiKey: string): LLMError {
  const e = err as { name?: string; status?: number; statusCode?: number; message?: string; code?: string };
  const status = e?.status ?? e?.statusCode;
  let kind: LLMErrorKind;
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (status === undefined) kind = 'network';
  else kind = 'api';
  const rawMessage = e?.message ?? String(err ?? 'unknown error');
  const redactedMessage = redactDiagnostic(rawMessage, apiKey);
  const sensitiveDetailWasDropped = redactedMessage !== rawMessage;
  // The SDK's non-2xx message is built from the entire response body. Do not
  // repeat it: a compatible backend may reflect the prompt/request or return
  // secret-bearing diagnostic fields. Status + a bounded code are enough to
  // act, while network/abort messages have no response body and remain useful.
  const detail =
    status === undefined
      ? redactedMessage
      : `HTTP ${status}${e?.code ? ` (${redactDiagnostic(String(e.code).slice(0, 128), apiKey)})` : ''}${sensitiveDetailWasDropped ? ' ***' : ''}`;
  return new LLMError(kind, `LLM ${kind} error (${provider}): ${detail}`, status);
}

// ---------------------------------------------------------------------------
// Tool mapping (our shape -> each wire format)
// ---------------------------------------------------------------------------

/**
 * Anthropic prompt caching (GA, no beta header needed): a `cache_control`
 * block marks "cache everything up to and including this block". Anthropic
 * caps the number of active breakpoints per request at 4 — we use at most 2
 * (system, tools), never one per tool, so the count stays fixed regardless
 * of catalog size. See `buildAnthropicRequest` for the ordering rationale.
 */
const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' as const };

function toAnthropicTools(tools: LLMTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function toOpenAITools(tools: LLMTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ---------------------------------------------------------------------------
// Stop-reason normalization
// ---------------------------------------------------------------------------

function normalizeAnthropicStop(reason: unknown): LLMStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function normalizeOpenAIStop(reason: unknown): LLMStopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'content_filter') return 'content_filter';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Anthropic protocol
// ---------------------------------------------------------------------------

/**
 * Build the Anthropic `messages.create`/`.stream` request body, with
 * `cache_control` breakpoints on the two blocks that are genuinely stable
 * across turns of one conversation:
 *
 *   - `system`: the same instructions are re-sent every turn verbatim.
 *   - `tools`: the catalog is derived once per turn from the (unchanged)
 *     registry — same names/descriptions/schemas turn after turn within a
 *     session, so it round-trips byte-identical and is a cache HIT after the
 *     first turn.
 *
 * `messages` is deliberately left unmarked — it grows every turn (new user
 * turn + tool results appended), so marking it would make every request a
 * cache MISS while still paying the cache-write premium: strictly worse than
 * not caching at all.
 *
 * Anthropic evaluates cache breakpoints in request order — tools, then
 * system, then messages — so placing the marked blocks first (tools, system)
 * and the volatile block last (messages) keeps the cached prefix at the head
 * of the prompt, which is what the API requires for a hit.
 */
export function buildAnthropicRequest(cfg: ResolvedConfig, params: LLMCompleteParams): Record<string, unknown> {
  const req: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: params.maxTokens ?? 4096,
    // Block arrays map 1:1 to Anthropic content blocks; strings pass through.
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (params.tools && params.tools.length > 0) {
    const tools = toAnthropicTools(params.tools);
    // One breakpoint on the LAST tool caches the whole preceding tool list as
    // a single prefix — not one breakpoint per tool (that would blow the
    // 4-breakpoint cap on any catalog bigger than a handful of tools).
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: CACHE_CONTROL_EPHEMERAL,
    };
    req.tools = tools;
  }
  if (params.system.length > 0) {
    // System-as-content-blocks (not a plain string) is what lets us attach
    // cache_control to it at all — Anthropic only accepts the marker on a
    // content block, never on the bare string form.
    req.system = [{ type: 'text', text: params.system, cache_control: CACHE_CONTROL_EPHEMERAL }];
  } else {
    req.system = params.system;
  }
  return req;
}

/** Raw Anthropic `usage` object shape (present on non-stream responses and
 *  on `message_start`/`message_delta` stream events). */
interface RawAnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function parseAnthropicUsage(raw: RawAnthropicUsage | undefined): LLMUsage | undefined {
  if (!raw) return undefined;
  const usage: LLMUsage = {};
  if (typeof raw.input_tokens === 'number') usage.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') usage.outputTokens = raw.output_tokens;
  if (typeof raw.cache_creation_input_tokens === 'number')
    usage.cacheCreationInputTokens = raw.cache_creation_input_tokens;
  if (typeof raw.cache_read_input_tokens === 'number') usage.cacheReadInputTokens = raw.cache_read_input_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseAnthropicResponse(resp: unknown): LLMResponse {
  const r = resp as {
    content?: Array<Record<string, unknown>>;
    stop_reason?: unknown;
    usage?: RawAnthropicUsage;
  };
  const blocks = r.content ?? [];
  const textParts: string[] = [];
  const toolCalls: LLMToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id),
        name: String(b.name),
        input: (b.input as Record<string, unknown>) ?? {},
      });
    }
  }
  return {
    content: textParts.length > 0 ? textParts.join('') : null,
    toolCalls,
    stopReason: normalizeAnthropicStop(r.stop_reason),
    usage: parseAnthropicUsage(r.usage),
  };
}

async function* streamAnthropic(
  client: AnthropicClientLike,
  cfg: ResolvedConfig,
  params: LLMCompleteParams,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const textParts: string[] = [];
  const toolCalls: LLMToolCall[] = [];
  let stopReason: LLMStopReason = 'end_turn';
  // Accumulator for the tool_use block currently being streamed, keyed by index.
  const pending = new Map<number, { id: string; name: string; json: string }>();
  // Usage arrives in two pieces: `message_start` carries input/cache tokens,
  // `message_delta` carries the (cumulative) output token count. Merge both.
  let usage: LLMUsage | undefined;
  const mergeUsage = (raw: RawAnthropicUsage | undefined): void => {
    const parsed = parseAnthropicUsage(raw);
    if (!parsed) return;
    usage = { ...usage, ...parsed };
  };

  let iterable: AsyncIterable<unknown>;
  try {
    iterable = client.messages.stream(buildAnthropicRequest(cfg, params), { signal: params.signal });
  } catch (err) {
    throw mapError(err, cfg.provider, cfg.apiKey);
  }

  try {
    for await (const raw of iterable) {
      const ev = raw as {
        type?: string;
        index?: number;
        content_block?: Record<string, unknown>;
        delta?: Record<string, unknown>;
        message?: { usage?: RawAnthropicUsage };
        usage?: RawAnthropicUsage;
      };
      switch (ev.type) {
        case 'message_start': {
          mergeUsage(ev.message?.usage);
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block ?? {};
          if (cb.type === 'tool_use') {
            pending.set(ev.index ?? 0, { id: String(cb.id), name: String(cb.name), json: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta ?? {};
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            textParts.push(d.text);
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const acc = pending.get(ev.index ?? 0);
            if (acc) acc.json += d.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const acc = pending.get(ev.index ?? 0);
          if (acc) {
            const call: LLMToolCall = {
              id: acc.id,
              name: acc.name,
              input: acc.json ? (JSON.parse(acc.json) as Record<string, unknown>) : {},
            };
            toolCalls.push(call);
            pending.delete(ev.index ?? 0);
            yield { type: 'tool_call', call };
          }
          break;
        }
        case 'message_delta': {
          const d = ev.delta ?? {};
          if (d.stop_reason !== undefined) stopReason = normalizeAnthropicStop(d.stop_reason);
          mergeUsage(ev.usage);
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    throw mapError(err, cfg.provider, cfg.apiKey);
  }

  yield {
    type: 'done',
    response: {
      content: textParts.length > 0 ? textParts.join('') : null,
      toolCalls,
      stopReason,
      usage,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compat protocol
// ---------------------------------------------------------------------------

/**
 * Translate our messages into OpenAI chat-completions shape. Block arrays are
 * expanded: assistant `tool_use` blocks become `tool_calls`; a user message of
 * `tool_result` blocks becomes one `{role:'tool'}` message per block (the tool
 * role replaces the user-role wrapper entirely).
 */
function toOpenAIMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        }
      }
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
      };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user turn — tool_result blocks become standalone 'tool' messages;
      // any remaining text is emitted as a normal user message.
      const textParts: string[] = [];
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('') });
    }
  }
  return out;
}

function buildOpenAIRequest(cfg: ResolvedConfig, params: LLMCompleteParams, stream: boolean): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: params.system },
    ...toOpenAIMessages(params.messages),
  ];
  const req: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: params.maxTokens ?? 4096,
    messages,
  };
  if (params.tools && params.tools.length > 0) {
    req.tools = toOpenAITools(params.tools);
  }
  if (stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return req;
}

function parseOpenAIUsage(raw: unknown): LLMUsage | undefined {
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  if (!usage) return undefined;
  const parsed: LLMUsage = {};
  if (typeof usage.prompt_tokens === 'number') parsed.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') parsed.outputTokens = usage.completion_tokens;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseOpenAIResponse(resp: unknown): LLMResponse {
  const r = resp as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> };
      finish_reason?: unknown;
    }>;
    usage?: unknown;
  };
  const choice = r.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: LLMToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    const fn = (tc.function as { name?: string; arguments?: string }) ?? {};
    return {
      id: String(tc.id),
      name: String(fn.name),
      input: fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {},
    };
  });
  return {
    content: msg.content ?? null,
    toolCalls,
    stopReason: normalizeOpenAIStop(choice?.finish_reason),
    usage: parseOpenAIUsage(r.usage),
  };
}

async function* streamOpenAI(
  client: OpenAIClientLike,
  cfg: ResolvedConfig,
  params: LLMCompleteParams,
): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const textParts: string[] = [];
  // A stream that closes without a terminal finish_reason is not a successful
  // turn; keep it unknown unless the wire explicitly proves otherwise.
  let stopReason: LLMStopReason = 'unknown';
  let usage: LLMUsage | undefined;
  // Tool-call fragments accumulate by index; arguments arrive as JSON-string chunks.
  const pending = new Map<number, { id: string; name: string; args: string }>();
  const order: number[] = [];

  let iterable: AsyncIterable<unknown>;
  try {
    iterable = (await client.chat.completions.create(buildOpenAIRequest(cfg, params, true), {
      signal: params.signal,
    })) as AsyncIterable<unknown>;
  } catch (err) {
    throw mapError(err, cfg.provider, cfg.apiKey);
  }

  try {
    for await (const raw of iterable) {
      const chunk = raw as {
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: Array<Record<string, unknown>> };
          finish_reason?: unknown;
        }>;
        usage?: unknown;
      };
      usage = parseOpenAIUsage(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        textParts.push(delta.content);
        yield { type: 'text_delta', text: delta.content };
      }
      for (const frag of delta.tool_calls ?? []) {
        const idx = (frag.index as number) ?? 0;
        let acc = pending.get(idx);
        if (!acc) {
          acc = { id: '', name: '', args: '' };
          pending.set(idx, acc);
          order.push(idx);
        }
        if (frag.id) acc.id = String(frag.id);
        const fn = (frag.function as { name?: string; arguments?: string }) ?? {};
        if (fn.name) acc.name = fn.name;
        if (fn.arguments) acc.args += fn.arguments;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        stopReason = normalizeOpenAIStop(choice.finish_reason);
      }
    }
  } catch (err) {
    throw mapError(err, cfg.provider, cfg.apiKey);
  }

  const toolCalls: LLMToolCall[] = [];
  for (const idx of order) {
    const acc = pending.get(idx)!;
    const call: LLMToolCall = {
      id: acc.id,
      name: acc.name,
      input: acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {},
    };
    toolCalls.push(call);
    yield { type: 'tool_call', call };
  }

  yield {
    type: 'done',
    response: {
      content: textParts.length > 0 ? textParts.join('') : null,
      toolCalls,
      stopReason,
      usage,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock protocol (deterministic, offline)
// ---------------------------------------------------------------------------

function mockResponse(params: LLMCompleteParams): LLMResponse {
  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const text = `echo: ${lastUser?.content ?? ''}`;
  return { content: text, toolCalls: [], stopReason: 'end_turn' };
}

async function* streamMock(params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown> {
  const response = mockResponse(params);
  const text = response.content ?? '';
  // Emit word-by-word so callers can exercise incremental rendering.
  const words = text.split(/(\s+)/).filter((w) => w.length > 0);
  for (const w of words) {
    yield { type: 'text_delta', text: w };
  }
  yield { type: 'done', response };
}

// ---------------------------------------------------------------------------
// Lazy real SDK client construction (prod path; skipped when deps injected)
// ---------------------------------------------------------------------------

async function buildAnthropic(cfg: ResolvedConfig): Promise<AnthropicClientLike> {
  const mod = await import('@anthropic-ai/sdk');
  const Anthropic = (mod as unknown as { default: new (opts: Record<string, unknown>) => AnthropicClientLike }).default;
  return new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
}

async function buildOpenAI(cfg: ResolvedConfig): Promise<OpenAIClientLike> {
  const mod = (await import('openai')) as unknown as {
    default?: new (opts: Record<string, unknown>) => OpenAIClientLike;
    OpenAI?: new (opts: Record<string, unknown>) => OpenAIClientLike;
  };
  const OpenAI = mod.default ?? mod.OpenAI;
  if (typeof OpenAI !== 'function') {
    throw new LLMError('api', 'Installed OpenAI SDK has no compatible constructor export');
  }
  // OpenAI-compat servers (Ollama/LM Studio) may not require a key; send a placeholder.
  return new OpenAI({
    apiKey: cfg.apiKey || 'not-needed',
    baseURL: cfg.baseURL,
    ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLLMClient(config: LLMClientConfig, deps: LLMClientDeps = {}): LLMClient {
  const cfg = resolveConfig(config);

  if (cfg.protocol === 'anthropic' && cfg.provider === 'mock') {
    // The mock provider is classified as the anthropic protocol in the catalog,
    // but it never touches a real SDK — dispatch it explicitly.
    return {
      provider: cfg.provider,
      model: cfg.model,
      protocol: cfg.protocol,
      async complete(params) {
        return mockResponse(params);
      },
      stream(params) {
        return streamMock(params);
      },
    };
  }

  if (cfg.protocol === 'anthropic') {
    let cached: AnthropicClientLike | undefined = deps.anthropic;
    const getClient = async () => (cached ??= await buildAnthropic(cfg));
    return {
      provider: cfg.provider,
      model: cfg.model,
      protocol: cfg.protocol,
      async complete(params) {
        try {
          const client = await getClient();
          const resp = await client.messages.create(buildAnthropicRequest(cfg, params), {
            signal: params.signal,
          });
          return parseAnthropicResponse(resp);
        } catch (err) {
          if (err instanceof LLMError) throw err;
          throw mapError(err, cfg.provider, cfg.apiKey);
        }
      },
      async *stream(params) {
        const client = await getClient();
        yield* streamAnthropic(client, cfg, params);
      },
    };
  }

  // openai-compat family
  let cached: OpenAIClientLike | undefined = deps.openai;
  const getClient = async () => (cached ??= await buildOpenAI(cfg));
  return {
    provider: cfg.provider,
    model: cfg.model,
    protocol: cfg.protocol,
    async complete(params) {
      try {
        const client = await getClient();
        const resp = await client.chat.completions.create(buildOpenAIRequest(cfg, params, false), {
          signal: params.signal,
        });
        return parseOpenAIResponse(resp);
      } catch (err) {
        if (err instanceof LLMError) throw err;
        throw mapError(err, cfg.provider, cfg.apiKey);
      }
    },
    async *stream(params) {
      const client = await getClient();
      yield* streamOpenAI(client, cfg, params);
    },
  };
}
