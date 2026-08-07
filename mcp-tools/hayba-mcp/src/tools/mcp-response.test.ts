import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toMcpResponse, registerJsonTool } from './mcp-response.js';

describe('toMcpResponse', () => {
  it('wraps a value as a single pretty-printed text content block', () => {
    const r = toMcpResponse({ ok: true, n: 3 });
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toBe('{\n  "ok": true,\n  "n": 3\n}');
  });

  it('handles primitives and arrays', () => {
    expect(toMcpResponse('hi').content[0].text).toBe('"hi"');
    expect(toMcpResponse([1, 2]).content[0].text).toBe('[\n  1,\n  2\n]');
  });
});

describe('registerJsonTool', () => {
  /** Minimal fake server that captures the registered callback. */
  function fakeServer() {
    const calls: Array<{ name: string; description: string; schema: unknown }> = [];
    let registered: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    const server = {
      tool: (name: string, description: string, schema: unknown, cb: typeof registered) => {
        calls.push({ name, description, schema });
        registered = cb;
      },
    } as unknown as McpServer;
    return { server, calls, invoke: (args: Record<string, unknown>) => registered!(args) };
  }

  it('registers the tool with name, description, and schema', () => {
    const { server, calls } = fakeServer();
    registerJsonTool(server, 'demo', 'a demo tool', { x: undefined as never }, async () => ({ ok: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'demo', description: 'a demo tool' });
  });

  it('passes args to run and wraps the result via toMcpResponse', async () => {
    const { server, invoke } = fakeServer();
    registerJsonTool(server, 'echo', 'echoes', {},
      (args: { value: number }) => ({ doubled: args.value * 2 }));
    const out = await invoke({ value: 21 });
    expect(out).toEqual({ content: [{ type: 'text', text: '{\n  "doubled": 42\n}' }] });
  });

  it('awaits an async run before wrapping', async () => {
    const { server, invoke } = fakeServer();
    registerJsonTool(server, 'slow', 'async tool', {},
      async () => Promise.resolve({ done: true }));
    const out = await invoke({});
    expect(out).toEqual({ content: [{ type: 'text', text: '{\n  "done": true\n}' }] });
  });
});
