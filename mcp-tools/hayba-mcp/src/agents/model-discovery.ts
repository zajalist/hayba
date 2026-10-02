/** Read-only, bounded provider catalog discovery. No inference request is made. */
import { createHmac, randomBytes } from 'node:crypto';
import { getProvider } from './providers.js';

export type ToolUseSupport = 'yes' | 'no' | 'unknown' | 'conditional' | 'trained';
export type DiscoveryStatus = 'ok' | 'partial' | 'no_key' | 'manual' | 'unavailable';
export type DiscoveryReason =
  | 'auth' | 'rate_limited' | 'network' | 'upstream' | 'invalid_response'
  | 'unsafe_endpoint' | 'custom_endpoint' | 'unsupported';

export interface DiscoveredModel {
  id: string;
  name: string;
  chat_capable: boolean | null;
  tool_use: ToolUseSupport;
  context_tokens?: number;
  effective_context_tokens?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  reasoning_efforts?: string[];
  input_usd_per_million?: number;
  output_usd_per_million?: number;
  loaded?: boolean;
  size_bytes?: number;
  active?: boolean;
}

export interface ModelDiscoveryResult {
  provider: string;
  status: DiscoveryStatus;
  models: DiscoveredModel[];
  fetched_at: string | null;
  stale: boolean;
  cached: boolean;
  partial: boolean;
  manual_entry_allowed: true;
  reason?: DiscoveryReason;
  retry_after_seconds?: number;
  note?: string;
}

export interface ModelDiscoveryInput {
  provider: string;
  apiKey?: string;
  baseURL?: string;
  currentModel?: string;
  refresh?: boolean;
  /** Legacy caller flag; custom endpoints always require manual model entry. */
  probeCustom?: boolean;
}

type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
let fetcher: Fetcher = fetch;
let now = () => Date.now();

interface CacheEntry {
  result: ModelDiscoveryResult;
  freshUntil: number;
  staleUntil: number;
  retryUntil: number;
}
const cache = new Map<string, CacheEntry>();
const cacheHmacKey = randomBytes(32);
const MAX_CACHE_ENTRIES = 64;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 3000;
const MAX_PAGES = 5;
const LOCAL_DETAIL_LIMIT = 24;

/** Test seam. Never pass a real key to test fetchers. */
export function __setModelDiscoveryFetch(value: Fetcher): void { fetcher = value; }
export function __setModelDiscoveryClock(value: () => number): void { now = value; }
export function __resetModelDiscovery(): void { cache.clear(); fetcher = fetch; now = () => Date.now(); }

function record(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}
function modelId(value: unknown): string | undefined {
  const id = str(value)?.trim();
  return id && !/[\s\x00-\x1f\x7f]/.test(id) ? id : undefined;
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length <= 64).slice(0, 16);
}
function pricePerMillion(value: unknown): number | undefined {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}
function model(idValue: unknown, nameValue?: unknown): DiscoveredModel | null {
  const id = modelId(idValue);
  if (!id) return null;
  return { id, name: str(nameValue) || id, chat_capable: null, tool_use: 'unknown' };
}
function dedupe(items: DiscoveredModel[]): DiscoveredModel[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].slice(0, MAX_MODELS);
}
function result(provider: string, status: DiscoveryStatus, models: DiscoveredModel[] = []): ModelDiscoveryResult {
  return { provider, status, models, fetched_at: status === 'ok' || status === 'partial' ? new Date(now()).toISOString() : null,
    stale: false, cached: false, partial: status === 'partial', manual_entry_allowed: true };
}

class DiscoveryError extends Error {
  constructor(readonly reason: DiscoveryReason, readonly retryAfterSeconds?: number, readonly httpStatus?: number) {
    super(reason);
  }
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, Math.min(300, seconds)) : undefined;
}

async function getJson(url: string, headers: HeadersInit = {}, method = 'GET', body?: string): Promise<Json> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetcher(url, { method, body, headers, signal: controller.signal, redirect: 'error', cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new DiscoveryError('auth', undefined, response.status);
      if (response.status === 429) throw new DiscoveryError('rate_limited', retryAfter(response.headers.get('retry-after')), response.status);
      throw new DiscoveryError('upstream', undefined, response.status);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new DiscoveryError('invalid_response');
    if (!response.body) throw new DiscoveryError('invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new DiscoveryError('invalid_response'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const object = record(parsed);
    if (!object) throw new DiscoveryError('invalid_response');
    return object;
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    if (error instanceof SyntaxError) throw new DiscoveryError('invalid_response');
    throw new DiscoveryError('network');
  } finally { clearTimeout(timeout); }
}

function sameOfficialBase(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return true;
  try {
    const a = new URL(candidate);
    const b = new URL(expected);
    return a.username === '' && a.password === '' && a.search === '' && a.hash === '' &&
      a.protocol === b.protocol && a.host === b.host && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
  } catch { return false; }
}

function localOrigin(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new DiscoveryError('unsafe_endpoint'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) {
    throw new DiscoveryError('unsafe_endpoint');
  }
  return url.origin;
}

async function discoverRemote(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const entry = getProvider(input.provider);
  if (!entry) return { ...result(input.provider, 'manual'), reason: 'unsupported' };
  if (!sameOfficialBase(input.baseURL, entry.baseURLDefault)) {
    return { ...result(input.provider, 'manual'), reason: 'custom_endpoint',
      note: 'The configured endpoint differs from the provider preset. Enter its model ID manually.' };
  }
  if (!input.apiKey) return { ...result(input.provider, 'no_key'), note: 'Configure this provider key to list available models.' };
  const bearer = { Authorization: `Bearer ${input.apiKey}` };
  const items: DiscoveredModel[] = [];
  let partial = false;
  if (input.provider === 'anthropic') {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('after_id', cursor);
      const data = await getJson(url.href, { ...bearer, 'anthropic-version': '2023-06-01' });
      if (!Array.isArray(data.data)) throw new DiscoveryError('invalid_response');
      for (const raw of data.data) {
        const item = record(raw); const m = item && model(item.id, item.display_name);
        if (!item || !m) continue;
        m.chat_capable = true;
        m.context_tokens = positive(item.max_input_tokens);
        m.max_output_tokens = positive(item.max_tokens);
        const capabilities = record(item.capabilities);
        if (record(capabilities?.image_input)?.supported === true) m.input_modalities = ['text', 'image'];
        const effort = record(capabilities?.effort);
        if (effort) m.reasoning_efforts = Object.entries(effort)
          .filter(([name, value]) => name !== 'supported' && record(value)?.supported === true)
          .map(([name]) => name);
        items.push(m);
      }
      if (!data.has_more || items.length >= MAX_MODELS) { partial = Boolean(data.has_more); break; }
      cursor = str(data.last_id);
      if (!cursor || page === MAX_PAGES - 1) { partial = true; break; }
    }
  } else if (input.provider === 'openrouter') {
    const limit = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://openrouter.ai/api/v1/models/user');
      url.searchParams.set('offset', String(page * limit));
      url.searchParams.set('limit', String(limit));
      const data = await getJson(url.href, bearer);
      if (!Array.isArray(data.data)) throw new DiscoveryError('invalid_response');
      for (const raw of data.data) {
        const item = record(raw); const m = item && model(item.id, item.name);
        if (!item || !m) continue;
        const architecture = record(item.architecture);
        m.input_modalities = strings(architecture?.input_modalities);
        m.output_modalities = strings(architecture?.output_modalities);
        m.chat_capable = m.input_modalities && m.output_modalities
          ? m.input_modalities.includes('text') && m.output_modalities.includes('text') : null;
        const parameters = strings(item.supported_parameters);
        m.tool_use = parameters ? parameters.includes('tools') ? 'conditional' : 'no' : 'unknown';
        m.context_tokens = positive(item.context_length);
        m.max_output_tokens = positive(record(item.top_provider)?.max_completion_tokens);
        m.input_usd_per_million = pricePerMillion(record(item.pricing)?.prompt);
        m.output_usd_per_million = pricePerMillion(record(item.pricing)?.completion);
        items.push(m);
      }
      const total = positive(data.total_count);
      if (items.length >= MAX_MODELS) { partial = true; break; }
      if ((total && items.length >= total) || (!total && data.data.length < limit) || data.data.length === 0) break;
      if (page === MAX_PAGES - 1) partial = true;
    }
  } else {
    const url = input.provider === 'openai' ? 'https://api.openai.com/v1/models'
      : input.provider === 'deepseek' ? 'https://api.deepseek.com/models'
      : 'https://api.groq.com/openai/v1/models';
    const data = await getJson(url, bearer);
    if (!Array.isArray(data.data)) throw new DiscoveryError('invalid_response');
    for (const raw of data.data) {
      const item = record(raw); const m = item && model(item.id, item.name);
      if (!item || !m) continue;
      if (input.provider === 'deepseek') {
        m.context_tokens = positive(item.context_window);
        m.max_output_tokens = positive(item.max_output_tokens);
        m.input_modalities = strings(item.input_modalities);
        m.output_modalities = strings(item.output_modalities);
        m.reasoning_efforts = strings(record(item.effort)?.supported_levels);
        m.chat_capable = m.input_modalities && m.output_modalities
          ? m.input_modalities.includes('text') && m.output_modalities.includes('text') : null;
      } else if (input.provider === 'groq') {
        if (item.active === false) continue;
        m.active = item.active === true;
        m.context_tokens = positive(item.context_window);
        m.chat_capable = null; // Groq lists speech and guard models too.
      }
      items.push(m);
    }
    if (items.length > MAX_MODELS) partial = true;
  }
  const found = result(input.provider, partial ? 'partial' : 'ok', dedupe(items));
  if (input.provider === 'openai' || input.provider === 'groq') {
    found.note = 'The provider model API does not identify chat/tool support or price. Select a model explicitly.';
  }
  return found;
}

async function discoverLocal(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const entry = getProvider(input.provider)!;
  const origin = localOrigin(input.baseURL || entry.baseURLDefault);
  const headers: Record<string, string> = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {};
  if (input.provider === 'lmstudio') {
    let data: Json;
    try { data = await getJson(`${origin}/api/v1/models`, headers); }
    catch (error) {
      if (!(error instanceof DiscoveryError) || error.httpStatus !== 404) throw error;
      data = await getJson(`${origin}/v1/models`, headers);
      if (!Array.isArray(data.data)) throw new DiscoveryError('invalid_response');
      return result(input.provider, 'ok', dedupe(data.data.map((raw) => {
        const item = record(raw); return item && model(item.id);
      }).filter((m): m is DiscoveredModel => Boolean(m))));
    }
    if (!Array.isArray(data.models)) throw new DiscoveryError('invalid_response');
    const items = data.models.map((raw) => {
      const item = record(raw); const m = item && model(item.key, item.display_name);
      if (!item || !m || item.type !== 'llm') return null;
      m.chat_capable = true;
      m.context_tokens = positive(item.max_context_length);
      const loaded = array(item.loaded_instances).map(record).filter((x): x is Json => Boolean(x));
      m.loaded = loaded.length > 0;
      m.effective_context_tokens = positive(record(loaded[0]?.config)?.context_length);
      m.size_bytes = positive(item.size_bytes);
      const capabilities = record(item.capabilities);
      m.tool_use = capabilities?.trained_for_tool_use === true ? 'trained' : 'unknown';
      m.input_modalities = capabilities?.vision === true ? ['text', 'image'] : ['text'];
      m.reasoning_efforts = strings(record(capabilities?.reasoning)?.allowed_options);
      return m;
    }).filter((m): m is DiscoveredModel => Boolean(m));
    return result(input.provider, items.length > MAX_MODELS ? 'partial' : 'ok', dedupe(items));
  }
  const data = await getJson(`${origin}/api/tags`, headers);
  if (!Array.isArray(data.models)) throw new DiscoveryError('invalid_response');
  const items = data.models.map((raw) => {
    const item = record(raw); const m = item && model(item.name || item.model);
    if (!item || !m) return null;
    m.size_bytes = positive(item.size);
    return m;
  }).filter((m): m is DiscoveredModel => Boolean(m));
  const prioritized = [...items].sort((a, b) => Number(b.id === input.currentModel) - Number(a.id === input.currentModel));
  const detailIds = prioritized.slice(0, LOCAL_DETAIL_LIMIT).map((m) => m.id);
  const details: PromiseSettledResult<Json>[] = [];
  for (let start = 0; start < detailIds.length; start += 4) {
    const batch = detailIds.slice(start, start + 4).map((id) =>
      getJson(`${origin}/api/show`, { ...headers, 'content-type': 'application/json' }, 'POST', JSON.stringify({ model: id })));
    details.push(...await Promise.allSettled(batch));
  }
  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    if (detail.status !== 'fulfilled') continue;
    const m = items.find((candidate) => candidate.id === detailIds[i])!;
    const features = strings(detail.value.capabilities);
    m.chat_capable = features ? features.includes('completion') : null;
    m.tool_use = features ? features.includes('tools') ? 'yes' : 'no' : 'unknown';
    m.input_modalities = features?.includes('vision') ? ['text', 'image'] : ['text'];
    const info = record(detail.value.model_info);
    if (info) {
      const context = Object.entries(info).find(([key, value]) => key.endsWith('.context_length') && positive(value));
      m.context_tokens = context ? positive(context[1]) : undefined;
    }
  }
  try {
    const running = await getJson(`${origin}/api/ps`, headers);
    for (const raw of array(running.models)) {
      const entry = record(raw); const id = modelId(entry?.name || entry?.model);
      const m = items.find((candidate) => candidate.id === id);
      if (m) { m.loaded = true; m.effective_context_tokens = positive(entry?.context_length); }
    }
  } catch { /* Running-state metadata is optional. */ }
  return result(input.provider, items.length > MAX_MODELS || items.length > LOCAL_DETAIL_LIMIT ? 'partial' : 'ok', dedupe(items));
}

/** Returns availability evidence, never a guessed 'best' model or a credential. */
export async function discoverModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const entry = getProvider(input.provider);
  if (!entry) return { ...result(input.provider, 'manual'), reason: 'unsupported' };
  if (input.provider === 'mock') {
    const m = model('mock')!; m.chat_capable = true; m.tool_use = 'no';
    return result('mock', 'ok', [m]);
  }
  const hosted = ['anthropic', 'openai', 'deepseek', 'groq', 'openrouter'].includes(input.provider);
  const local = ['ollama', 'lmstudio'].includes(input.provider);
  if (!hosted && !local) {
    return { ...result(input.provider, 'manual'), note: 'Enter the model ID for this custom endpoint manually.' };
  }
  const base = input.baseURL || entry.baseURLDefault;
  // A process-random HMAC partitions cache entries by credential without storing
  // the raw key or a reusable unkeyed digest of it.
  const keyTag = input.apiKey ? createHmac('sha256', cacheHmacKey).update(input.apiKey).digest('hex') : '';
  const cacheKey = JSON.stringify([input.provider, base, keyTag, input.currentModel]);
  const current = cache.get(cacheKey);
  const time = now();
  if (current && time < current.retryUntil) {
    return { ...current.result, cached: true, stale: time >= current.freshUntil };
  }
  if (!input.refresh && current && time < current.freshUntil) return { ...current.result, cached: true };
  try {
    const fresh = hosted ? await discoverRemote(input) : await discoverLocal(input);
    const ttl = local ? 15_000 : 15 * 60_000;
    cache.set(cacheKey, { result: fresh, freshUntil: time + ttl, staleUntil: time + 24 * 60 * 60_000, retryUntil: 0 });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return fresh;
  } catch (error) {
    const failure = error instanceof DiscoveryError ? error : new DiscoveryError('network');
    const fallback = current && time < current.staleUntil && current.result.models.length > 0 ? current.result.models : [];
    const failed: ModelDiscoveryResult = { ...result(input.provider, 'unavailable', fallback),
      fetched_at: fallback.length ? current!.result.fetched_at : null, stale: fallback.length > 0,
      reason: failure.reason, retry_after_seconds: failure.retryAfterSeconds,
      note: fallback.length ? 'Previously listed models are stale; verify before selecting.' : 'Enter a model ID manually or retry discovery.' };
    const delay = failure.reason === 'rate_limited' ? (failure.retryAfterSeconds || 60) * 1000 : 10_000;
    cache.set(cacheKey, { result: failed, freshUntil: time, staleUntil: time + 24 * 60 * 60_000, retryUntil: time + delay });
    return failed;
  }
}
