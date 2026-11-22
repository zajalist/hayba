import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient, LLMCompleteParams } from '../agents/llm-client.js';
import { SessionStore } from './session-store.js';
import { SubagentManager } from './subagents.js';

const directories: string[] = [];
const managers: SubagentManager[] = [];
afterEach(() => { managers.forEach(manager => manager.dispose()); managers.length = 0; directories.forEach(dir => rmSync(dir, { recursive: true, force: true })); directories.length = 0; vi.useRealTimers(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'hayba-child-')); directories.push(directory);
  const store = new SessionStore(directory); const parent = store.create('parent');
  const manager = new SubagentManager(store); managers.push(manager);
  return { directory, store, parent, manager };
}
const tools = ['actor_list', 'actor_spawn', 'asset_search', 'delegate_task'].map(name => ({ name, description: '', input_schema: { type: 'object' as const, properties: {} } }));
function client(stream: LLMClient['stream']): LLMClient { return { provider: 'mock', model: 'test', protocol: 'anthropic', complete: async () => { throw new Error('unused'); }, stream }; }
async function settle(manager: SubagentManager, id: string) { await vi.waitFor(() => expect(manager.list('parent').find(agent => agent.id === id)?.status).not.toBe('running')); return manager.list('parent').find(agent => agent.id === id)!; }

describe('real isolated read-only child tasks', () => {
  it('lets a delegating parent await the actual child completion and findings', async () => {
    const { manager } = setup();
    const child = manager.start('parent', { task: 'Inspect actors' }, { tools, dispatchTool: vi.fn(), client: client(async function* () { yield { type: 'text_delta', text: 'Child findings' }; yield { type: 'done', response: { content: 'Child findings', stopReason: 'end_turn', toolCalls: [] } }; }) });
    expect(await manager.wait('parent', child.id)).toMatchObject({ status: 'succeeded', output: 'Child findings' });
    await expect(manager.wait('other', child.id)).rejects.toThrow(/Unknown child/);
  });
  it('executes a separate specialist loop, records tool identity and output, and persists only a safe summary', async () => {
    const { manager, store, directory } = setup();
    const requests: LLMCompleteParams[] = [];
    const dispatch = vi.fn().mockResolvedValue({ actors: ['Tree'], raw: 'private-key' });
    const child = manager.start('parent', { task: 'Inspect actors', specialist_id: 'director' }, {
      tools, dispatchTool: dispatch, secrets: ['private-key'], client: client(async function* (params) {
        requests.push(structuredClone({ ...params, signal: undefined }));
        if (requests.length === 1) yield { type: 'done', response: { content: null, stopReason: 'tool_use', toolCalls: [{ id: 'child-call', name: 'actor_list', input: {} }] } };
        else { yield { type: 'text_delta', text: 'Found Tree private-key' }; yield { type: 'done', response: { content: 'Found Tree private-key', stopReason: 'end_turn', toolCalls: [] } }; }
      }),
    });
    const done = await settle(manager, child.id);
    expect(done).toMatchObject({ parent_session_id: 'parent', specialist_id: 'director', status: 'succeeded', output: 'Found Tree [REDACTED:api_key]', tools: [{ id: 'child-call', name: 'actor_list', status: 'succeeded' }] });
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'Inspect actors' }]);
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(['actor_list', 'asset_search']);
    expect(dispatch).toHaveBeenCalledWith('actor_list', {});
    expect(JSON.stringify(requests[1].messages)).not.toContain('private-key');
    expect(store.load('parent')!.messages).toEqual([]);
    expect(store.load('parent')!.subagents).toEqual([done]);
    const bytes = readFileSync(join(directory, 'parent.json'), 'utf8');
    expect(bytes).not.toContain('private-key'); expect(bytes).not.toContain('"raw"');
    expect(new SubagentManager(store).list('parent')).toEqual([done]);
  });
  it('refuses mutation and unknown tool names before the dispatcher', async () => {
    const { manager } = setup(); const dispatch = vi.fn(); let calls = 0;
    const child = manager.start('parent', { task: 'Inspect actors', specialist_id: 'director' }, { tools, dispatchTool: dispatch, client: client(async function* () {
      yield { type: 'done', response: calls++ === 0 ? { content: null, stopReason: 'tool_use', toolCalls: [{ id: 'bad', name: 'actor_spawn', input: {} }, { id: 'unknown', name: 'unknown_get', input: {} }, { id: 'recursive', name: 'delegate_task', input: { task: 'Nested task' } }] } : { content: 'Read only', stopReason: 'end_turn', toolCalls: [] } };
    }) });
    const done = await settle(manager, child.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(done.tools.every(tool => tool.status === 'failed')).toBe(true);
  });
  it('caps concurrency, cancels per parent, and reports provider failures without secret text', async () => {
    const { manager } = setup();
    const blocked = client(async function* (params) { await new Promise<void>(resolve => params.signal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('private-key'); yield { type: 'text_delta', text: '' }; });
    const input = { client: blocked, tools, dispatchTool: vi.fn(), secrets: ['private-key'] };
    const children = Array.from({ length: 3 }, () => manager.start('parent', { task: 'Inspect actors' }, input));
    expect(() => manager.start('parent', { task: 'Inspect again' }, input)).toThrow(/limit/i);
    manager.cancelParent('parent');
    for (const child of children) expect((await settle(manager, child.id)).status).toBe('cancelled');
    expect(JSON.stringify(manager.list('parent'))).not.toContain('private-key');
    expect(() => manager.start('parent', { task: 'Late inspection' }, input)).toThrow(/cancelled/i);
    manager.resumeParent('parent');
    const failed = manager.start('parent', { task: 'Inspect actors' }, { ...input, client: client(async function* () { throw new Error('private-key'); yield { type: 'text_delta', text: '' }; }) });
    expect(await settle(manager, failed.id)).toMatchObject({ status: 'failed', error: expect.any(String) });
    expect(JSON.stringify(manager.list('parent'))).not.toContain('private-key');
  });
  it('validates task/profile before invoking a model and never cancels another parent child', async () => {
    const { manager, store } = setup(); store.create('other'); const stream = vi.fn(); const params = { client: client(stream), tools, dispatchTool: vi.fn() };
    for (const task of ['', 'x'.repeat(4001)]) expect(() => manager.start('parent', { task }, params)).toThrow();
    expect(() => manager.start('parent', { task: 'Inspect', specialist_id: 'missing' }, params)).toThrow();
    expect(stream).not.toHaveBeenCalled();
    expect(() => manager.cancel('other', 'wrong')).toThrow();
  });
  it('bounds task launches over ten minutes and expires blocked model calls', async () => {
    const { manager } = setup();
    const params = { tools, dispatchTool: vi.fn(), client: client(async function* () { yield { type: 'text_delta', text: 'Done' }; yield { type: 'done', response: { content: 'Done', stopReason: 'end_turn', toolCalls: [] } }; }) };
    for (let i = 0; i < 30; i++) { const child = manager.start('parent', { task: 'Inspect' }, params); await settle(manager, child.id); }
    expect(() => manager.start('parent', { task: 'Inspect' }, params)).toThrow(/limit/i);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const resumed = manager.start('parent', { task: 'Inspect again' }, params);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.list('parent').find(agent => agent.id === resumed.id)?.status).toBe('succeeded');
    expect(manager.list('parent')).toHaveLength(30);
    const timed = new SubagentManager(setup().store, 10); managers.push(timed);
    const child = timed.start('parent', { task: 'Inspect' }, { ...params, client: client(async function* (params) { await new Promise<void>(resolve => params.signal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('deadline'); yield { type: 'text_delta', text: '' }; }) });
    await vi.advanceTimersByTimeAsync(11);
    expect(timed.list('parent').find(agent => agent.id === child.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('time limit') });
  });
  it('bounds visible output and tool history and marks truncation honestly', async () => {
    const { manager } = setup(); let turns = 0;
    const child = manager.start('parent', { task: 'Inspect actors' }, { tools, dispatchTool: vi.fn().mockResolvedValue({ ok: true }), client: client(async function* () {
      if (turns++ === 0) yield { type: 'done', response: { content: null, stopReason: 'tool_use', toolCalls: Array.from({ length: 20 }, (_, i) => ({ id: `call_${i}`, name: 'actor_list', input: {} })) } };
      else { yield { type: 'text_delta', text: '"'.repeat(10000) }; yield { type: 'done', response: { content: '"'.repeat(10000), stopReason: 'end_turn', toolCalls: [] } }; }
    }) });
    const done = await settle(manager, child.id);
    expect(done).toMatchObject({ status: 'succeeded', output_truncated: true, tools_truncated: true });
    expect(Buffer.byteLength(done.output)).toBe(4096);
    expect(done.tools).toHaveLength(16);
  });
});
