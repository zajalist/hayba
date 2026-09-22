import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Keep legacy server tests away from real project conversation history. */
export function temporarySessionStore(): SessionStore {
  const directory = mkdtempSync(join(tmpdir(), 'hayba-chat-test-'));
  directories.push(directory);
  return new SessionStore(directory);
}
