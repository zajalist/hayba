import { isIP } from 'node:net';
import { z } from 'zod';

export type Provider = 'meshy' | 'tripo' | 'aholo' | 'fal' | 'worldlabs';
export type MediaKind = 'model' | 'video' | 'splat';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Generation3DTask {
  provider: Provider;
  task_id: string;
  status: TaskStatus;
  progress: number | null;
  kind: MediaKind;
  result_url?: string;
  phase?: 'preview' | 'refine';
  model_url?: string;
  thumbnail_url?: string;
  error?: string;
}

const origins = { meshy: 'https://api.meshy.ai', tripo: 'https://openapi.tripo3d.com', aholo: 'https://api.aholo3d.cn', fal: 'https://queue.fal.run', worldlabs: 'https://api.worldlabs.ai' };
const falModel = 'fal-ai/wan/v2.7/text-to-video';
const styles = ['photorealistic', 'cartoon', 'anime', 'hand_painted', 'cyberpunk', 'fantasy', 'glass'] as const;
export const generation3DProviders = [
  { provider: 'meshy', name: 'Meshy', kind: 'model', text_to_3d: true, image_to_3d: false, refine: true, default_model: 'latest', models: ['latest', 'meshy-7.1', 'meshy-6', 'meshy-6-lite'], refine_models: ['latest', 'meshy-7', 'meshy-6', 'meshy-6-lite'], styles: [], numeric_progress: true, note: 'Preview is an untextured mesh. Refine is a separate billed action.' },
  { provider: 'tripo', name: 'Tripo', kind: 'model', text_to_3d: true, image_to_3d: true, refine: false, default_model: 'v3.1-20260211', models: ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123'], styles: [], numeric_progress: true, note: 'Choose text or one public HTTPS image URL. Result URLs expire.' },
  { provider: 'aholo', name: 'Aholo / Lux3D', kind: 'model', text_to_3d: true, image_to_3d: true, refine: false, default_model: 'G1-Turbo', models: ['G1', 'G1-Turbo'], styles, numeric_progress: false, note: 'Supports image-only or text with an optional reference image. No numeric progress is provided.' },
  { provider: 'fal', name: 'fal', kind: 'video', text_to_video: true, default_model: falModel, models: [falModel], numeric_progress: false, note: 'Wan 2.7 text-to-video, 5 seconds at 1080p. Each submission uses fal credits. Key is saved without a paid verification request.' },
  { provider: 'worldlabs', name: 'World Labs', kind: 'splat', text_to_splat: true, default_model: 'marble-1.1', models: ['marble-1.1', 'marble-1.1-plus', 'marble-1.0-draft'], numeric_progress: false, note: 'Text to a Marble world with an SPZ Gaussian splat download. Generation uses World Labs credits; Unreal import requires compatible splat support.' },
] as const;

export class Generation3DError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); this.name = 'Generation3DError'; }
}
const invalid = () => new Generation3DError('INVALID_INPUT', 'Invalid or unsupported generation request.');
const protocol = () => new Generation3DError('UPSTREAM_INVALID_RESPONSE', 'The provider returned an invalid response.', 502);
const credentials = {
  provider: z.enum(['meshy', 'tripo', 'aholo', 'fal', 'worldlabs']),
  api_key: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/),
};
const connectionSchema = z.strictObject(credentials);
const taskIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const createSchema = z.strictObject({ ...credentials, prompt: z.string().trim().min(1).max(2000).optional(), model: z.string().max(64).optional(), image_url: z.string().max(8192).optional(), style: z.enum(styles).optional(), preview_task_id: taskIdSchema.optional() });
const statusSchema = z.strictObject({ ...credentials, task_id: taskIdSchema, phase: z.enum(['preview', 'refine']).optional() });
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid();
  return result.data;
}

/** URL validation only: this service never fetches image or result URLs. */
function safePublicUrl(value: unknown, key: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- Reject controls and whitespace before URL normalization can remove them.
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return;
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[')) return; // shortcut: reject IPv6 literals, add public IPv6 classification if required.
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0)) return;
    } else if (!host.includes('.') || host.endsWith('.') || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) return;
    const decoded = decodeURIComponent(value);
    if (decoded.includes(key)) return;
    return url.href;
  } catch { return; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocol();
  return value as Record<string, unknown>;
}
function taskId(value: unknown, provider: Provider, key: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) value = String(value);
  if (!taskIdSchema.safeParse(value).success || (typeof value === 'string' && value.includes(key))) throw protocol();
  if (provider === 'aholo' && !/^[1-9]\d{0,18}$/.test(value as string)) throw protocol();
  return value as string;
}
const statusMaps: Record<Exclude<Provider, 'fal' | 'worldlabs'>, Record<string, TaskStatus>> = {
  meshy: { PENDING: 'queued', IN_PROGRESS: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'cancelled' },
  tripo: { queued: 'queued', running: 'running', success: 'succeeded', failed: 'failed', cancelled: 'cancelled', banned: 'failed', expired: 'failed' },
  aholo: { 0: 'queued', 1: 'running', 3: 'succeeded', 4: 'failed', 6: 'cancelled' },
};

export function createGeneration3DClient(options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  async function request(provider: Provider, key: string, path: string, body?: object): Promise<unknown> {
    const url = new URL(path, origins[provider]);
    if (url.origin !== origins[provider] || !path.startsWith('/') || path.startsWith('//')) throw invalid();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const auth: Record<string, string> = provider === 'worldlabs' ? { 'WLT-Api-Key': key } : { Authorization: provider === 'aholo' ? key : provider === 'fal' ? `Key ${key}` : `Bearer ${key}` };
      const response = await fetch(url.href, { method: body ? 'POST' : 'GET', headers: { ...auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new Generation3DError('PROVIDER_AUTH_FAILED', 'The provider refused this API key or its permissions.', 401);
        if (response.status === 402) throw new Generation3DError('PROVIDER_CREDITS_REQUIRED', 'The provider requires available credits.', 402);
        if (response.status === 429) throw new Generation3DError('PROVIDER_RATE_LIMITED', 'The provider rate limit was reached. Try again later.', 429);
        if (provider === 'fal' && [422, 499].includes(response.status)) throw new Generation3DError(response.status === 499 ? 'TASK_CANCELLED' : 'TASK_FAILED', 'The provider could not complete this generation.', 502);
        throw new Generation3DError('UPSTREAM_REJECTED', 'The provider rejected the request. Check your provider account and supported settings.', 502);
      }
      if (Number(response.headers.get('content-length')) > 262144) { await response.body?.cancel(); throw protocol(); }
      if (!response.body) throw protocol();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 262144) { await reader.cancel(); throw protocol(); }
        chunks.push(value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw protocol(); }
    } catch (error) {
      if (error instanceof Generation3DError) throw error;
      if (controller.signal.aborted) throw new Generation3DError('UPSTREAM_TIMEOUT', 'The provider request timed out. A submitted task may still exist; check the provider before retrying.', 504);
      throw new Generation3DError('UPSTREAM_UNAVAILABLE', 'The provider could not be reached. A submitted task may still exist; check the provider before retrying.', 502);
    } finally { clearTimeout(timer); }
  }
  function unwrap(provider: Provider, response: unknown): unknown {
    if (provider === 'meshy') return response;
    const data = object(response);
    if ((provider === 'tripo' && data.code !== 0) || (provider === 'aholo' && data.c !== '0')) throw new Generation3DError('UPSTREAM_REJECTED', 'The provider rejected the request. Check your provider account and supported settings.', 502);
    return provider === 'tripo' ? data.data : data.d;
  }
  function mediaResult(provider: 'fal' | 'worldlabs', task_id: string, key: string, result: unknown, thumbnail?: unknown): Generation3DTask {
    const result_url = safePublicUrl(result, key), thumbnail_url = safePublicUrl(thumbnail, key);
    return { provider, task_id, kind: provider === 'fal' ? 'video' : 'splat', status: 'succeeded', progress: 100,
      ...(result_url ? { result_url } : { error: 'Generation completed, but the provider returned no safe result download URL.' }),
      ...(thumbnail_url ? { thumbnail_url } : {}) };
  }
  async function mediaStatus(provider: 'fal' | 'worldlabs', api_key: string, task_id: string): Promise<Generation3DTask> {
    const kind = provider === 'fal' ? 'video' : 'splat';
    const base = { provider, task_id, kind, progress: null } as const;
    if (provider === 'fal') {
      // Queue status/result paths use owner/app only, never the model endpoint suffix or returned URLs.
      const path = `/fal-ai/wan/requests/${task_id}`;
      const data = object(await request(provider, api_key, `${path}/status`));
      if (taskId(data.request_id, provider, api_key) !== task_id) throw protocol();
      if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') return { ...base, status: data.status === 'IN_QUEUE' ? 'queued' : 'running' };
      if (data.status !== 'COMPLETED') throw protocol();
      if (data.error || data.error_type) return { ...base, status: 'failed', error: 'The provider reported that generation failed. Check the task in your fal account.' };
      try {
        const result = object(await request(provider, api_key, path));
        return mediaResult(provider, task_id, api_key, result.video ? object(result.video).url : undefined);
      } catch (error) {
        if (error instanceof Generation3DError && ['TASK_FAILED', 'TASK_CANCELLED'].includes(error.code))
          return { ...base, status: error.code === 'TASK_CANCELLED' ? 'cancelled' : 'failed', error: 'The provider could not complete this generation.' };
        throw error;
      }
    }
    const operation = object(await request(provider, api_key, `/marble/v1/operations/${task_id}`));
    if (taskId(operation.operation_id, provider, api_key) !== task_id || typeof operation.done !== 'boolean') throw protocol();
    if (operation.error) return { ...base, status: 'failed', error: 'World Labs reported that generation failed. Check the operation in your provider account.' };
    if (!operation.done) return { ...base, status: 'running' };
    const world = object(operation.response), assets = world.assets ? object(world.assets) : {};
    const splats = assets.splats ? object(assets.splats) : {}, urls = splats.spz_urls ? object(splats.spz_urls) : {};
    const result = [urls.full_res, urls['500k'], urls['100k']].map(url => safePublicUrl(url, api_key)).find(Boolean);
    return mediaResult(provider, task_id, api_key, result, assets.thumbnail_url);
  }
  return {
    async connection(input: unknown) {
      const { provider, api_key } = parse(connectionSchema, input);
      if (provider === 'fal') return { provider, status: 'configured' as const, verified: false, message: 'Key saved. No free authentication probe is used; the first explicit generation verifies access and uses provider credits.' };
      if (provider === 'worldlabs') {
        const balance = object(await request(provider, api_key, '/marble/v1/credits')).remaining_credits;
        if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) throw protocol();
        return { provider, status: 'verified' as const, verified: true, message: 'API key accepted by a read-only provider request.' };
      }
      const path = provider === 'meshy' ? '/openapi/v2/text-to-3d?page_size=1' : provider === 'tripo' ? '/v3/account/balance' : '/lux3d/v1/generate/task/list?page=1&pagesize=1';
      const result = unwrap(provider, await request(provider, api_key, path));
      if (provider === 'meshy' ? !Array.isArray(result) : provider === 'tripo' ? typeof object(result).balance !== 'number' : !Array.isArray(object(result).items)) throw protocol();
      return { provider, status: 'verified' as const, verified: true, message: 'API key accepted by a read-only provider request.' };
    },
    async create(input: unknown): Promise<Generation3DTask> {
      const { provider, api_key, prompt, model, image_url, style, preview_task_id } = parse(createSchema, input);
      const info = generation3DProviders.find(p => p.provider === provider)!;
      if (provider === 'fal' || provider === 'worldlabs') {
        if (!prompt || image_url || style || preview_task_id || (model && !(info.models as readonly string[]).includes(model))) throw invalid();
        const body = provider === 'fal' ? { prompt, duration: 5, resolution: '1080p' } : { model: model ?? info.default_model, display_name: prompt.slice(0, 80), world_prompt: { type: 'text', text_prompt: prompt } };
        const data = object(await request(provider, api_key, provider === 'fal' ? `/${falModel}` : '/marble/v1/worlds:generate', body));
        const task_id = taskId(provider === 'fal' ? data.request_id : data.operation_id, provider, api_key);
        return { provider, task_id, kind: info.kind, status: 'queued', progress: null };
      }
      if (image_url && !safePublicUrl(image_url, api_key)) throw invalid();
      if (style && (provider !== 'aholo' || !prompt)) throw invalid();
      if (preview_task_id && provider !== 'meshy') throw invalid();
      if (preview_task_id?.includes(api_key)) throw invalid();
      if (provider === 'meshy' && (image_url || (prompt?.length ?? 0) > 800)) throw invalid();
      if (!prompt && !image_url && !preview_task_id) throw invalid();
      if (provider === 'tripo' && prompt && image_url) throw invalid();
      const selected = model ?? info.default_model;
      const allowed: readonly string[] = provider === 'meshy' && preview_task_id ? generation3DProviders[0].refine_models : info.models;
      if (model && !allowed.includes(model)) throw invalid();
      let path: string;
      let body: object;
      let phase: 'preview' | 'refine' | undefined;
      if (provider === 'meshy') {
        path = '/openapi/v2/text-to-3d';
        phase = preview_task_id ? 'refine' : 'preview';
        body = preview_task_id ? { mode: 'refine', preview_task_id, ...(prompt ? { texture_prompt: prompt } : {}), ...(model ? { ai_model: model } : {}) } : { mode: 'preview', prompt, ai_model: selected, target_formats: ['glb'] };
      } else if (provider === 'tripo') {
        path = `/v3/generation/${image_url ? 'image' : 'text'}-to-model`;
        body = { ...(image_url ? { input: image_url } : { prompt }), model: selected };
      } else {
        path = `/lux3d/v1/generate/${prompt ? 'text' : 'img'}-to-3d/task/create`;
        body = { ...(prompt ? { prompt } : {}), ...(image_url ? { img: image_url } : {}), version: selected, ...(style ? { style } : {}), outputFormat: ['glb'] };
      }
      const result = unwrap(provider, await request(provider, api_key, path, body));
      const task_id = taskId(provider === 'aholo' ? result : object(result)[provider === 'meshy' ? 'result' : 'task_id'], provider, api_key);
      return { provider, task_id, kind: 'model', status: 'queued', progress: provider === 'aholo' ? null : 0, ...(phase ? { phase } : {}) };
    },
    async status(input: unknown): Promise<Generation3DTask> {
      const { provider, api_key, task_id, phase } = parse(statusSchema, input);
      if (task_id.includes(api_key)) throw invalid();
      if (provider === 'aholo' && !/^[1-9]\d{0,18}$/.test(task_id)) throw invalid();
      if (provider !== 'meshy' && phase) throw invalid();
      if (provider === 'fal' || provider === 'worldlabs') return mediaStatus(provider, api_key, task_id);
      const path = provider === 'meshy' ? `/openapi/v2/text-to-3d/${task_id}` : provider === 'tripo' ? `/v3/tasks/${task_id}` : `/lux3d/v1/generate/task/get?taskid=${task_id}`;
      const data = object(unwrap(provider, await request(provider, api_key, path)));
      if (taskId(data[provider === 'meshy' ? 'id' : provider === 'tripo' ? 'task_id' : 'taskId'], provider, api_key) !== task_id) throw protocol();
      const status = statusMaps[provider][String(data.status)];
      if (!status) throw protocol();
      const progress = status === 'succeeded' ? 100 : typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0 && data.progress <= 100 ? data.progress : null;
      let model: unknown;
      let thumbnail: unknown;
      if (provider === 'meshy') { model = data.model_urls && object(data.model_urls).glb; thumbnail = data.thumbnail_url; }
      else if (provider === 'tripo') { const output = data.output ? object(data.output) : {}; model = output.model_url; thumbnail = output.rendered_image_url; }
      else if (Array.isArray(data.outputs)) {
        // All our Aholo requests ask for GLB; G1 may additionally return ZIP first.
        const urls = data.outputs.map(output => safePublicUrl(object(output).content, api_key)).filter((url): url is string => !!url);
        model = urls.find(url => new URL(url).pathname.toLowerCase().endsWith('.glb')) ?? (urls.length === 1 ? urls[0] : urls[1]);
      }
      const model_url = status === 'succeeded' ? safePublicUrl(model, api_key) : undefined;
      const thumbnail_url = safePublicUrl(thumbnail, api_key);
      return { provider, task_id, kind: 'model', status, progress, ...(provider === 'meshy' ? { phase: phase ?? (data.type === 'text-to-3d-refine' ? 'refine' : 'preview') } : {}), ...(model_url ? { model_url, result_url: model_url } : {}), ...(thumbnail_url ? { thumbnail_url } : {}), ...(status === 'failed' ? { error: 'The provider reported that generation failed. Check the task in your provider account.' } : status === 'succeeded' && !model_url ? { error: 'Generation completed, but the provider returned no safe model download URL.' } : {}) };
    },
  };
}
