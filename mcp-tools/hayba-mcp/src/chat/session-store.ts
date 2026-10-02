import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { LLMMessage } from '../agents/llm-client.js';
import type { WarningReviewRecord } from './agent-loop.js';
import { z } from 'zod';
import { redactBoundaryValue, redactSecrets } from '../security/secret-redaction.js';

// All free-form strings pass the central redactor, individually so its bounded
// traversal never truncates an older conversation as the session grows. Object
// schemas strip unknown fields at every level: provider/tool payloads cannot
// sneak through even when a caller passes a larger runtime object.
const safeText = z.string().transform((text) => redactSecrets(text).value);
const MessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: safeText });
const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
});
const ArtifactSchema = z.object({ kind: safeText, id: safeText, path: safeText.optional() });
const ActivitySchema = z.object({
  activityId: safeText,
  title: safeText,
  status: z.enum(['planning', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled']),
  specialistId: safeText.optional(),
  reason: safeText.optional(),
  steps: z.array(z.object({ name: safeText, status: z.enum(['running', 'succeeded', 'failed']) })),
});
const SessionSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(MessageSchema),
  activities: z.array(ActivitySchema),
  artifacts: z.array(ArtifactSchema),
  usage: UsageSchema.optional(),
});
const RecordSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() })).optional(),
  activity: ActivitySchema.optional(),
  artifacts: z.array(ArtifactSchema).optional(),
  usage: UsageSchema.optional(),
});

export type SavedSession = z.infer<typeof SessionSchema>;
export type SavedActivity = z.infer<typeof ActivitySchema>;
export type SessionSummary = Pick<SavedSession, 'id' | 'createdAt' | 'updatedAt'> & { messageCount: number; title: string };

export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(id) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id) &&
    !redactSecrets(id).summary.applied
  );
}

/** Text-only projection; tool-use and tool-result blocks are never saved. */
export function sessionMessages(input: unknown): SavedSession['messages'] {
  const messages = RecordSchema.shape.messages.parse(input) ?? [];
  return messages.flatMap((message) => {
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
          : '';
    return content ? [MessageSchema.parse({ role: message.role, content })] : [];
  });
}

/** Single-sidecar store. Synchronous read/modify/rename prevents interleaved
 * appends in this process; separate sidecar processes must use separate roots. */
export class SessionStore {
  constructor(private readonly directory = resolve(process.cwd(), 'Saved/HaybaMCP/sessions')) {}

  private path(id: string): string {
    if (!isValidSessionId(id)) throw new Error('invalid session id');
    return join(this.directory, `${id}.json`);
  }

  create(id: string = `sess_${randomUUID()}`): SavedSession {
    const path = this.path(id);
    if (existsSync(path)) throw new Error('session already exists');
    const now = new Date().toISOString();
    return this.write({ version: 1, id, createdAt: now, updatedAt: now, messages: [], activities: [], artifacts: [] });
  }

  load(id: string): SavedSession | null {
    const path = this.path(id);
    try {
      const session = SessionSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (session.id !== id) throw new Error('session id mismatch');
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  list(): SessionSummary[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json') && isValidSessionId(name.slice(0, -5)))
      .flatMap((name) => {
        const session = this.load(name.slice(0, -5));
        return session
          ? [
              {
                id: session.id,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                messageCount: session.messages.length,
                title: session.messages.find((message) => message.role === 'user')?.content.slice(0, 80) ?? 'New conversation',
              },
            ]
          : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  append(id: string, input: unknown): SavedSession {
    const session = this.load(id);
    if (!session) throw new Error('unknown session');
    const record = RecordSchema.parse(input);
    session.messages.push(...sessionMessages(record.messages));
    if (record.activity) {
      const index = session.activities.findIndex((activity) => activity.activityId === record.activity!.activityId);
      if (index < 0) session.activities.push(record.activity);
      else session.activities[index] = record.activity;
    }
    if (record.artifacts) session.artifacts.push(...record.artifacts);
    if (record.usage) {
      session.usage ??= {};
      for (const key of Object.keys(UsageSchema.shape) as Array<keyof z.infer<typeof UsageSchema>>) {
        if (record.usage[key] !== undefined) session.usage[key] = (session.usage[key] ?? 0) + record.usage[key];
      }
    }
    session.updatedAt = new Date().toISOString();
    return this.write(session);
  }

  /** Install the authoritative transcript without changing activity or usage history. */
  replaceMessages(id: string, input: unknown): SavedSession {
    const session = this.load(id);
    if (!session) throw new Error('unknown session');
    session.messages = sessionMessages(input);
    session.updatedAt = new Date().toISOString();
    return this.write(session);
  }

  remove(id: string): boolean {
    try {
      unlinkSync(this.path(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private write(session: SavedSession): SavedSession {
    // Project and redact BEFORE JSON serialization or opening even a temp file.
    const safe = SessionSchema.parse(session);
    const bytes = JSON.stringify(safe);
    const destination = this.path(safe.id);
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
    return safe;
  }
}

/** Durable, bounded text context for chat sessions. No tool payloads or approvals. */
export const CHAT_CONTEXT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_FILES = 64;
const MAX_MESSAGES = 100;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 16_384;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function validChatSessionId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export function chatSessionDir(): string {
  if (process.env.HAYBA_CHAT_SESSION_DIR) return process.env.HAYBA_CHAT_SESSION_DIR;
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const projectKey = createHash('sha256').update(projectRoot).digest('hex').slice(0, 32);
  // LocalAppData inherits the user's Windows ACL; POSIX uses the user's state
  // directory and mode 0700 below. The override is for explicit deployments.
  const userState =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(userState, 'HaybaMCP', 'chat-context', projectKey);
}

function filePath(dir: string, id: string): string {
  // Validate at the filesystem boundary, including callers that bypass the
  // HTTP route. The prefix makes Windows device names safe filenames.
  if (!ID_RE.test(id) || basename(id) !== id) throw new Error('invalid chat session id');
  const root = resolve(dir);
  const path = resolve(root, `ctx_${id}.json`);
  if (dirname(path) !== root) throw new Error('chat session path escaped its directory');
  return path;
}

function textOnly(messages: LLMMessage[]): LLMMessage[] {
  const clean: LLMMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    // Tool calls/results can contain scene data and credentials, and replaying
    // a half-completed tool exchange after restart would be protocol-unsafe.
    const raw =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : '';
    if (!raw) continue;
    const content = redactBoundaryValue(raw.slice(0, MAX_TEXT_CHARS));
    if (typeof content === 'string' && content) clean.push({ role: message.role, content });
  }
  return clean.slice(-MAX_MESSAGES);
}

export interface StoredWarningReviews {
  reviews: WarningReviewRecord[];
  overflow: boolean;
  overflowSources?: string[];
  overflowValidatedSources?: string[];
  overflowReview?: { status: 'deferred'; reason: string };
}

function cleanWarningReviews(value: StoredWarningReviews): StoredWarningReviews {
  const reviews: WarningReviewRecord[] = [];
  let overflow = value.overflow === true;
  for (const record of value.reviews) {
    if (reviews.length >= 63) { overflow = true; break; }
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(record.id) ||
      !['pending', 'acknowledged', 'deferred'].includes(record.status)) continue;
    reviews.push({
      id: record.id,
      status: record.status,
      ...(typeof record.reason === 'string'
        ? { reason: redactBoundaryValue(record.reason.slice(0, 500)) as string } : {}),
    });
  }
  const overflowSources = (value.overflowSources ?? []).filter((key) => /^[a-f0-9]{16}$/.test(key)).slice(0, 16);
  const overflowValidatedSources = (value.overflowValidatedSources ?? [])
    .filter((key) => overflowSources.includes(key)).slice(0, 16);
  const overflowReview = value.overflowReview?.status === 'deferred' && typeof value.overflowReview.reason === 'string'
    ? { status: 'deferred' as const, reason: redactBoundaryValue(value.overflowReview.reason.slice(0, 500)) as string }
    : undefined;
  return { reviews, overflow, overflowSources, overflowValidatedSources,
    ...(overflowReview ? { overflowReview } : {}) };
}

interface StoredChatContext {
  messages: LLMMessage[];
  warnings: StoredWarningReviews;
}

function parseRecord(value: unknown, id: string, now: number): StoredChatContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { version?: unknown; id?: unknown; savedAt?: unknown; messages?: unknown; warnings?: unknown };
  if (
    record.version !== 1 ||
    record.id !== id ||
    typeof record.savedAt !== 'number' ||
    !Number.isFinite(record.savedAt) ||
    record.savedAt > now + 60_000 ||
    now - record.savedAt > CHAT_CONTEXT_TTL_MS ||
    !Array.isArray(record.messages) ||
    record.messages.length > MAX_MESSAGES
  )
    return null;
  if (
    !record.messages.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length <= MAX_TEXT_CHARS,
    )
  )
    return null;
  const warnings = record.warnings as { reviews?: unknown; overflow?: unknown; overflowSources?: unknown; overflowValidatedSources?: unknown; overflowReview?: { status?: unknown; reason?: unknown } } | undefined;
  if (warnings && (
    !Array.isArray(warnings.reviews) || warnings.reviews.length > 63 || typeof warnings.overflow !== 'boolean' ||
    !warnings.reviews.every((r) => r && typeof r === 'object' &&
      /^[a-z][a-z0-9_]{0,79}$/.test(r.id) &&
      ['pending', 'acknowledged', 'deferred'].includes(r.status) &&
      (r.reason === undefined || (typeof r.reason === 'string' && r.reason.length <= 500))) ||
    (warnings.overflowSources !== undefined && (!Array.isArray(warnings.overflowSources) ||
      warnings.overflowSources.length > 16 || !warnings.overflowSources.every((key: unknown) =>
        typeof key === 'string' && /^[a-f0-9]{16}$/.test(key)))) ||
    (warnings.overflowValidatedSources !== undefined && (!Array.isArray(warnings.overflowValidatedSources) ||
      warnings.overflowValidatedSources.length > 16 || !warnings.overflowValidatedSources.every((key: unknown) =>
        typeof key === 'string' && /^[a-f0-9]{16}$/.test(key)))) ||
    (warnings.overflowReview !== undefined && (!warnings.overflowReview ||
      warnings.overflowReview.status !== 'deferred' || typeof warnings.overflowReview.reason !== 'string' ||
      warnings.overflowReview.reason.length > 500))
  )) return null;
  return {
    messages: textOnly(record.messages as LLMMessage[]),
    warnings: warnings ? { reviews: warnings.reviews as WarningReviewRecord[], overflow: warnings.overflow as boolean,
      overflowSources: warnings.overflowSources as string[] | undefined,
      overflowValidatedSources: warnings.overflowValidatedSources as string[] | undefined,
      overflowReview: warnings.overflowReview as StoredWarningReviews['overflowReview'] }
      : { reviews: [], overflow: false },
  };
}

export function loadChatState(dir: string, id: string, now = Date.now()): StoredChatContext {
  const empty = (): StoredChatContext => ({ messages: [], warnings: { reviews: [], overflow: false } });
  if (!validChatSessionId(id)) return empty();
  const path = filePath(dir, id);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return empty();
    if (stat.size <= MAX_FILE_BYTES) {
      const state = parseRecord(JSON.parse(readFileSync(path, 'utf8')), id, now);
      if (state) return state;
    }
  } catch {
    // A missing, corrupt, or interrupted write starts with clean context.
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // An inaccessible directory is reported when the turn tries to save.
  }
  return empty();
}

export function loadChatContext(dir: string, id: string, now = Date.now()): LLMMessage[] {
  return loadChatState(dir, id, now).messages;
}

export function pruneChatContexts(dir: string, now = Date.now()): void {
  if (!existsSync(dir)) return;
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('ctx_') || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(4, -5);
    if (!ID_RE.test(id)) continue;
    const path = filePath(dir, id);
    try {
      const stat = statSync(path);
      const valid =
        stat.size <= MAX_FILE_BYTES && parseRecord(JSON.parse(readFileSync(path, 'utf8')), id, now) !== null;
      if (now - stat.mtimeMs > CHAT_CONTEXT_TTL_MS || !valid) rmSync(path, { force: true });
      else files.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      rmSync(path, { force: true });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(MAX_FILES)) rmSync(file.path, { force: true });
}

export function saveChatContext(dir: string, id: string, messages: LLMMessage[], now = Date.now(), warnings: StoredWarningReviews = { reviews: [], overflow: false }): void {
  if (!validChatSessionId(id)) return;
  const clean = textOnly(messages);
  const safeWarnings = cleanWarningReviews(warnings);
  // Drop oldest turns until the on-disk representation fits the fixed bound.
  let payload = JSON.stringify({ version: 1, id, savedAt: now, messages: clean, warnings: safeWarnings });
  while (Buffer.byteLength(payload) > MAX_FILE_BYTES && clean.length > 0) {
    clean.shift();
    payload = JSON.stringify({ version: 1, id, savedAt: now, messages: clean, warnings: safeWarnings });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      const bytes = Buffer.from(payload);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset);
        if (written <= 0) throw new Error('chat context write made no progress');
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, filePath(dir, id));
  } finally {
    rmSync(temp, { force: true });
  }
  pruneChatContexts(dir, now);
}
