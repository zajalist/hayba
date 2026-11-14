import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceHost, type ChatClient } from './workspace-host.js';

function mockChat(): ChatClient & { configs: Record<string, unknown>[] } {
  const configs: Record<string, unknown>[] = [];
  return {
    configs,
    async config(body) {
      configs.push(body);
      return { ok: true };
    },
    async stream(_body, onEvent) {
      onEvent({ event: 'text_delta', data: { text: 'Hello from Hayba.' } });
      onEvent({ event: 'done', data: { assistant_text: 'Hello from Hayba.' } });
    },
    async cancel() {},
  };
}

describe('standalone workspace host', () => {
  it('saves an API key, selects the provider, and streams a reply', async () => {
    const vaultPath = join(mkdtempSync(join(tmpdir(), 'hayba-app-')), 'vault.json');
    const chat = mockChat();
    const host = new WorkspaceHost(chat, vaultPath);
    await host.handle({ action: 'submit_chat_key', provider: 'anthropic', value: 'sk-ant-test-key-1234' });
    expect(host.vault.keys.anthropic).toBe('sk-ant-test-key-1234');
    expect(JSON.parse(readFileSync(vaultPath, 'utf8')).keys.anthropic).toBe('sk-ant-test-key-1234');
    const sent = await host.handle({ action: 'send', value: 'Hello', seq: 1 });
    expect(sent.messages[0]).toMatchObject({ role: 'user', text: 'Hello' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = host.snapshot();
    expect(live.messages.at(-1)?.text).toBe('Hello from Hayba.');
    expect(chat.configs[0]).toMatchObject({ provider: 'anthropic', api_key: 'sk-ant-test-key-1234' });
    expect(live.busy).toBe(false);
  });

  it('keeps the draft and opens settings when no key is stored', async () => {
    const host = new WorkspaceHost(mockChat(), join(mkdtempSync(join(tmpdir(), 'hayba-app-')), 'vault.json'));
    const snapshot = await host.handle({ action: 'send', value: 'Need a key', seq: 1 });
    expect(snapshot.workspace.view).toBe('settings');
    expect(snapshot.workspace.draft.text).toBe('Need a key');
    expect(snapshot.messages).toEqual([]);
  });
});
