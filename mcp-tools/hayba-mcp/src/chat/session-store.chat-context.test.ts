import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChatContext, loadChatState, pruneChatContexts, saveChatContext } from './session-store.js';

describe('chat context paths', () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hayba-chat-context-'));
    dir = join(root, 'sessions');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('round-trips a valid ID inside the configured directory', () => {
    const id = 'sess_Abc-123';
    const messages = [{ role: 'user' as const, content: 'Inspect the level' }];
    saveChatContext(dir, id, messages);

    expect(readdirSync(dir)).toEqual([`ctx_${id}.json`]);
    expect(loadChatContext(dir, id)).toEqual(messages);
    expect(JSON.parse(readFileSync(join(dir, `ctx_${id}.json`), 'utf8')).id).toBe(id);
  });

  it('rejects traversal and filename tricks without reading, writing, or deleting siblings', () => {
    const outside = join(root, 'ctx_outside.json');
    writeFileSync(outside, 'sentinel');
    for (const id of [
      '../outside',
      '..\\outside',
      'a/b',
      'a\\b',
      '.',
      'a.json',
      '%2e%2e',
      'a\0b',
      'a'.repeat(129),
    ]) {
      expect(loadChatState(dir, id)).toEqual({ messages: [], warnings: { reviews: [], overflow: false } });
      saveChatContext(dir, id, [{ role: 'user', content: 'should not persist' }]);
    }

    expect(readFileSync(outside, 'utf8')).toBe('sentinel');
    expect(existsSync(dir)).toBe(false);
  });

  it('prunes only canonical context filenames and leaves unrelated files alone', () => {
    saveChatContext(dir, 'valid', [{ role: 'user', content: 'Keep this' }]);
    writeFileSync(join(dir, 'ctx_invalid.name.json'), 'unrelated');
    writeFileSync(join(dir, 'ctx_bad.json'), 'corrupt');
    writeFileSync(join(dir, 'notes.txt'), 'unrelated');

    pruneChatContexts(dir);

    expect(readdirSync(dir).sort()).toEqual(['ctx_invalid.name.json', 'ctx_valid.json', 'notes.txt']);
    expect(loadChatContext(dir, 'valid')).toEqual([{ role: 'user', content: 'Keep this' }]);
  });
});
