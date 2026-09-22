import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { LLMClient, LLMCompleteParams } from '../agents/llm-client.js';
import { registerChatRoutes, __resetChatState } from './chat-server.js';

describe('chat server specialist routing compatibility', () => {
  let server: Server;
  afterEach(() => {
    server?.close();
    __resetChatState();
  });

  it.each([
    [undefined, ['asset_search']],
    ['blueprint-generator', ['asset_search', 'actor_list']],
    ['missing', undefined],
  ] as const)('honors archetype %s over inferred intent', async (archetype, expectedTools) => {
    const requests: LLMCompleteParams[] = [];
    const response = { content: 'Done', toolCalls: [], stopReason: 'end_turn' as const };
    const client: LLMClient = {
      provider: 'mock',
      model: 'fake',
      protocol: 'anthropic',
      complete: async () => response,
      async *stream(params) {
        requests.push(params);
        yield { type: 'done', response };
      },
    };
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      createClient: () => client,
      tools: ['asset_search', 'actor_list'].map((name) => ({
        name,
        description: '',
        input_schema: { type: 'object', properties: {} },
      })),
      dispatchTool: async () => ({}),
    });
    server = app.listen(0);
    const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Find Content Browser assets by path', provider: 'mock', archetype }),
    });
    const frames = await result.text();
    expect(frames).toContain('event: done');
    expect(frames).not.toContain('specialistId');
    if (expectedTools) {
      expect(requests[0].tools?.map((tool) => tool.name)).toEqual(expectedTools);
      expect(frames).not.toContain('event: error');
    } else {
      expect(requests).toHaveLength(0);
      expect(frames).toContain('unknown archetype id');
    }
  });
});
