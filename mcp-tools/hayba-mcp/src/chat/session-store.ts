import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '../security/secret-redaction.js';

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
export type SessionSummary = Pick<SavedSession, 'id' | 'createdAt' | 'updatedAt'> & { messageCount: number };

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
