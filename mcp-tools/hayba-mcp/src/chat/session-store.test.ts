import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe('SessionStore', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hayba-sessions-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a text transcript, activity summary, artifacts and neutral usage across instances', () => {
    const store = new SessionStore(directory);
    const session = store.create();
    store.append(session.id, {
      messages: [
        { role: 'user', content: 'List actors' },
        { role: 'assistant', content: 'Found two.' },
      ],
      activity: {
        activityId: 'activity-1',
        title: 'List actors',
        status: 'succeeded',
        steps: [{ name: 'actor_list', status: 'succeeded' }],
      },
      artifacts: [{ kind: 'asset', id: 'tree', path: '/Game/Tree' }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const reopened = new SessionStore(directory);
    expect(reopened.load(session.id)).toMatchObject({
      id: session.id,
      messages: [
        { role: 'user', content: 'List actors' },
        { role: 'assistant', content: 'Found two.' },
      ],
      activities: [
        { activityId: 'activity-1', status: 'succeeded', steps: [{ name: 'actor_list', status: 'succeeded' }] },
      ],
      artifacts: [{ kind: 'asset', id: 'tree', path: '/Game/Tree' }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(reopened.list()).toEqual([expect.objectContaining({ id: session.id, messageCount: 2, title: 'List actors' })]);
    expect(readdirSync(directory)).toEqual([`${session.id}.json`]);
    expect(reopened.remove(session.id)).toBe(true);
    expect(reopened.load(session.id)).toBeNull();
    expect(reopened.remove(session.id)).toBe(false);
    expect(reopened.list()).toEqual([]);
  });

  it('redacts secrets and strips raw tool payloads and provider objects before writing bytes', () => {
    const store = new SessionStore(directory);
    const session = store.create();
    store.append(session.id, {
      messages: [
        { role: 'user', content: 'api_key=SENTINEL_KEY Authorization: Bearer SENTINEL_HEADER_123456' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Safe summary' },
            { type: 'tool_use', id: 'call', name: 'actor_list', input: { query: 'SENTINEL_ARGUMENT' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'SENTINEL_RESULT' }] },
      ],
      activity: {
        activityId: 'a',
        title: 'Safe activity',
        status: 'succeeded',
        steps: [
          { name: 'actor_list', status: 'succeeded', input: { value: 'SENTINEL_NESTED' }, result: 'SENTINEL_BODY' },
        ],
        argsHash: 'SENTINEL_HASH',
        provider: { raw: 'SENTINEL_PROVIDER' },
      },
      artifacts: [{ kind: 'asset', id: 'tree', path: '/Game/Tree', body: 'SENTINEL_ARTIFACT_BODY' }],
      usage: { inputTokens: 12, providerObject: 'SENTINEL_USAGE' },
      apiKey: 'SENTINEL_CONFIG',
      authorization: 'SENTINEL_AUTH',
    });
    const bytes = readFileSync(join(directory, `${session.id}.json`), 'utf8');
    expect(bytes).not.toContain('SENTINEL');
    expect(bytes).toContain('[REDACTED:');
    expect(store.load(session.id)?.messages).toHaveLength(2);
    expect(store.load(session.id)?.messages[1]).toEqual({ role: 'assistant', content: 'Safe summary' });
    expect(store.load(session.id)?.usage).toEqual({ inputTokens: 12 });
  });

  it('merges activity updates and token totals without overwriting another append', () => {
    const first = new SessionStore(directory);
    const second = new SessionStore(directory);
    const { id } = first.create();
    first.append(id, {
      activity: { activityId: 'a', title: 'Work', status: 'running', steps: [] },
      usage: { inputTokens: 2 },
    });
    second.append(id, {
      activity: { activityId: 'a', title: 'Work', status: 'succeeded', steps: [] },
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    expect(first.load(id)?.activities).toHaveLength(1);
    expect(first.load(id)?.activities[0].status).toBe('succeeded');
    expect(first.load(id)?.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
  });

  it('rejects traversal identifiers and does not recreate removed sessions on append', () => {
    const store = new SessionStore(directory);
    for (const id of [
      '../outside',
      'a/b',
      'a\\b',
      '..',
      'C:outside',
      'CON',
      'sk-ant-api03-SENTINEL_PROVIDER_KEY_123456789',
    ]) {
      expect(() => store.load(id)).toThrow(/invalid session id/);
      expect(() => store.create(id)).toThrow(/invalid session id/);
      expect(() => store.remove(id)).toThrow(/invalid session id/);
    }
    const { id } = store.create();
    store.remove(id);
    expect(() => store.append(id, { messages: [] })).toThrow(/unknown session/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('preserves the previous JSON when an append fails validation', () => {
    const store = new SessionStore(directory);
    const { id } = store.create();
    const before = readFileSync(join(directory, `${id}.json`), 'utf8');
    expect(() => store.append(id, { usage: { inputTokens: -1 } })).toThrow();
    expect(readFileSync(join(directory, `${id}.json`), 'utf8')).toBe(before);
    writeFileSync(join(directory, 'unfinished.tmp'), '{');
    expect(store.list()).toHaveLength(1);
  });

  it('replaces message history through redaction while preserving activities, artifacts, and usage', () => {
    const store = new SessionStore(directory);
    const { id } = store.create();
    store.append(id, {
      messages: [
        { role: 'user', content: 'Old prompt' },
        { role: 'assistant', content: 'Old answer' },
      ],
      activity: { activityId: 'a', title: 'Work', status: 'succeeded', steps: [] },
      artifacts: [{ kind: 'asset', id: 'tree', path: '/Game/Tree' }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const before = store.load(id)!;
    const replaced = store.replaceMessages(id, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'New prompt api_key=SENTINEL_REPLACEMENT' },
          { type: 'tool_result', tool_use_id: 'call', content: 'SENTINEL_RESULT' },
        ],
      },
    ]);
    expect(replaced.messages).toEqual([
      { role: 'user', content: expect.stringMatching(/^New prompt api_key=\[REDACTED:/) },
    ]);
    expect(replaced.activities).toEqual(before.activities);
    expect(replaced.artifacts).toEqual(before.artifacts);
    expect(replaced.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(readFileSync(join(directory, `${id}.json`), 'utf8')).not.toContain('SENTINEL');
    expect(store.replaceMessages(id, []).messages).toEqual([]);
    expect(store.load(id)?.activities).toEqual(before.activities);
  });

  it('persists only bounded turn choices when a conversation resumes', () => {
    const store = new SessionStore(directory);
    const { id } = store.create();
    store.replaceMessages(id, [{ role: 'user', content: 'Inspect the plaza' }], {
      provider: 'anthropic', model: 'claude-opus-4-8', reasoningEffort: 'high',
      mode: 'draft', loop: 'community', apiKey: 'SENTINEL_KEY',
    });
    const reopened = new SessionStore(directory).load(id);
    expect(reopened?.turnSettings).toEqual({
      provider: 'anthropic', model: 'claude-opus-4-8', reasoningEffort: 'high',
      mode: 'draft', loop: 'community',
    });
    expect(readFileSync(join(directory, `${id}.json`), 'utf8')).not.toContain('SENTINEL_KEY');
    store.replaceMessages(id, [{ role: 'user', content: 'Continue' }]);
    expect(store.load(id)?.turnSettings).toEqual(reopened?.turnSettings);
  });

  it('writes redacted temporary bytes and preserves the old JSON if atomic replacement fails', () => {
    const store = new SessionStore(directory);
    const { id } = store.create();
    const target = join(directory, `${id}.json`);
    const previous = readFileSync(target, 'utf8');
    let temporaryBytes = '';
    vi.mocked(fs.renameSync).mockImplementationOnce((temporary) => {
      temporaryBytes = readFileSync(temporary, 'utf8');
      expect(readFileSync(target, 'utf8')).toBe(previous);
      throw new Error('disk unavailable');
    });
    expect(() => store.append(id, { messages: [{ role: 'user', content: 'api_key=SENTINEL_TEMP' }] })).toThrow(
      'disk unavailable',
    );
    expect(temporaryBytes).toContain('[REDACTED:');
    expect(temporaryBytes).not.toContain('SENTINEL_TEMP');
    expect(readFileSync(target, 'utf8')).toBe(previous);
    expect(readdirSync(directory)).toEqual([`${id}.json`]);
  });
});
