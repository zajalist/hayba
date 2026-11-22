/**
 * BYOK (Community loop) chats get python_run and editing tools by default; the
 * editor Settings toggle sends permissions.python_run=false to withhold it.
 * The loop also gets the configurable step budget, not the old cap of 16.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerChatRoutes, resolvePermissions, __resetChatState } from './chat-server.js';
import { DEFAULT_MAX_STEPS } from './agent-loop.js';
import type { LLMClient, LLMStreamEvent, LLMTool } from '../agents/llm-client.js';
import { temporarySessionStore } from './session-store.test-helpers.js';

const TOOLS: LLMTool[] = ['python_run', 'actor_spawn', 'actor_list'].map((name) => ({
  name, description: name, input_schema: { type: 'object', properties: {} },
}));

describe('BYOK chat tool access', () => {
  let server: Server;
  afterEach(() => {
    server?.close();
    __resetChatState();
  });

  async function offeredTools(body: Record<string, unknown>): Promise<string[]> {
    let offered: string[] = [];
    const client: LLMClient = {
      provider: 'anthropic', model: 'fake', protocol: 'anthropic',
      async complete() { return { content: 'ok', toolCalls: [], stopReason: 'end_turn' }; },
      async *stream(req): AsyncGenerator<LLMStreamEvent, void, unknown> {
        offered = (req.tools ?? []).map((t) => t.name);
        yield { type: 'done', response: { content: 'ok', toolCalls: [], stopReason: 'end_turn' } };
      },
    };
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore: temporarySessionStore(),
      createClient: () => client,
      dispatchTool: async () => ({ ok: true }),
      tools: TOOLS,
    });
    server = app.listen(0);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'make a cube', provider: 'anthropic', loop: 'community', ...body }),
    });
    await res.text();
    return offered;
  }

  it('offers python_run and edit tools to a BYOK chat by default', async () => {
    expect(await offeredTools({ mode: 'production' })).toEqual(expect.arrayContaining(['python_run', 'actor_spawn', 'actor_list']));
  });

  it('withholds only python_run when the setting turns it off', async () => {
    const offered = await offeredTools({ mode: 'production', permissions: { python_run: false } });
    expect(offered).toEqual(expect.arrayContaining(['actor_spawn', 'actor_list']));
    expect(offered).not.toContain('python_run');
  });

  it('defaults python_run on for Pro permissions too', () => {
    expect(resolvePermissions(undefined).python_run).toBe(true);
    expect(resolvePermissions({ python_run: false }).python_run).toBe(false);
  });

  it('gives chat turns a realistic step budget', () => {
    expect(DEFAULT_MAX_STEPS).toBe(60);
  });
});
