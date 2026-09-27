import { z } from 'zod';
import { ActivityEventSchema } from './activity-events.js';

export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

const sid = z.string().min(1).max(128);
const envelope = { v: z.literal(PROTOCOL_VERSION), session_id: sid, seq: z.number().int().nonnegative() };
const idStr = z.string().min(1).max(256);

export const ToolManifestEntrySchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4000),
  input_schema: z.record(z.string(), z.unknown()),
}).strict();

export const PermissionsSchema = z.object({
  'tools.execute': z.boolean(),
  'facts.vision': z.boolean(),
  'facts.scene': z.boolean(),
  python_run: z.boolean(),
}).strict();

export const LlmModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('subscription') }).strict(),
  z.object({
    mode: z.literal('byok'),
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    api_key: z.string().min(1),
  }).strict(),
]);

export const LimitsSchema = z.object({
  max_steps: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
  wall_clock_ms: z.number().int().positive(),
}).strict();

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
}).strict();

export const ProUnavailableReasonSchema = z.enum([
  'capacity', 'user_concurrency', 'quota', 'not_entitled', 'auth', 'maintenance', 'not_configured', 'unreachable',
]);

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
}).strict();

export const FrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'), ...envelope,
    access_token: z.string().min(1),
    client_version: z.string().min(1),
    ue_version: z.string().optional(),
    manifest: z.array(ToolManifestEntrySchema).max(2000),
    permissions: PermissionsSchema,
    llm: LlmModeSchema,
  }).strict(),
  z.object({
    type: z.literal('welcome'), ...envelope,
    limits: LimitsSchema,
    protocol_range: z.tuple([z.number().int(), z.number().int()]),
    resumed: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('turn'), ...envelope,
    messages: z.array(MessageSchema).min(1),
    mode: z.enum(['explore', 'draft', 'production']),
    pinned_specialist_id: z.string().min(1).optional(),
    activity_title: z.string().min(1).optional(),
  }).strict(),
  z.object({ type: z.literal('event'), ...envelope, event: ActivityEventSchema }).strict(),
  z.object({
    type: z.literal('tool_call'), ...envelope,
    id: idStr, name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()), gated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('tool_result'), ...envelope,
    id: idStr, ok: z.boolean(), result: z.unknown(), truncated: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal('approve'), ...envelope, name: z.string().min(1), args_hash: z.string() }).strict(),
  z.object({ type: z.literal('cancel'), ...envelope }).strict(),
  z.object({ type: z.literal('facts'), ...envelope, facts: z.array(z.record(z.string(), z.unknown())).max(500) }).strict(),
  z.object({ type: z.literal('done'), ...envelope, reason: z.string().min(1), usage: UsageSchema.optional() }).strict(),
  z.object({ type: z.literal('ping'), ...envelope }).strict(),
  z.object({
    type: z.literal('resume'), ...envelope,
    access_token: z.string().min(1), last_seq: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('pro_unavailable'), ...envelope,
    reason: ProUnavailableReasonSchema, message: z.string().min(1), retry_after_s: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    type: z.literal('upgrade_required'), ...envelope,
    min_version: z.number().int().positive(), download_url: z.string().url(),
  }).strict(),
]);

export type Frame = z.infer<typeof FrameSchema>;
type Of<T extends Frame['type']> = Extract<Frame, { type: T }>;
export type Hello = Of<'hello'>; export type Welcome = Of<'welcome'>; export type Turn = Of<'turn'>;
export type EventFrame = Of<'event'>; export type ToolCall = Of<'tool_call'>; export type ToolResult = Of<'tool_result'>;
export type Approve = Of<'approve'>; export type Cancel = Of<'cancel'>; export type Facts = Of<'facts'>;
export type Done = Of<'done'>; export type Ping = Of<'ping'>; export type Resume = Of<'resume'>;
export type ProUnavailable = Of<'pro_unavailable'>; export type UpgradeRequired = Of<'upgrade_required'>;
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type LlmMode = z.infer<typeof LlmModeSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type ProUnavailableReason = z.infer<typeof ProUnavailableReasonSchema>;
/** A frame body before the sender stamps the envelope. */
export type Outbound<T extends Frame> = T extends Frame ? Omit<T, 'v' | 'session_id' | 'seq'> : never;

export type ParseResult = { ok: true; frame: Frame } | { ok: false; error: string };

export function parseFrame(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'frame is not valid JSON' };
  }
  const r = FrameSchema.safeParse(json);
  if (!r.success) {
    return { ok: false, error: r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
  }
  return { ok: true, frame: r.data };
}
