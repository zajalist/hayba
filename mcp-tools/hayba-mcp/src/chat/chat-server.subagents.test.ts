import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMClient, LLMClientConfig } from '../agents/llm-client.js';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import { temporarySessionStore } from './session-store.test-helpers.js';

let server: Server;
let contextDir: string;
afterEach(async () => { __resetChatState(); vi.unstubAllEnvs(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (contextDir) rmSync(contextDir, { recursive: true, force: true }); });
async function start(client: LLMClient, childClient: LLMClient = client) {
  const store = temporarySessionStore(); store.create('parent'); store.create('other');
  const configs: LLMClientConfig[] = [];
  const app = express(); app.use(express.json());
  contextDir = mkdtempSync(join(tmpdir(), 'hayba-delegation-context-'));
  const dispatch = vi.fn().mockResolvedValue({ actors: ['Tree'] });
  registerChatRoutes(app, { sessionStore: store, sessionDir: contextDir, tools: [{ name: 'actor_list', description: '', input_schema: { type: 'object', properties: {} } }], createClient: cfg => { configs.push(cfg); return configs.length === 1 ? client : childClient; }, dispatchTool: dispatch });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, configs, url, post, dispatch };
}
const complete: LLMClient = { provider: 'mock', model: 'test', protocol: 'anthropic', complete: async () => { throw new Error('unused'); }, async *stream() { yield { type: 'text_delta', text: 'Inspected separately' }; yield { type: 'done', response: { content: 'Inspected separately', stopReason: 'end_turn', toolCalls: [] } }; } };
const coordinator: LLMClient = { ...complete, async *stream(params) {
  const last = params.messages.at(-1);
  if (params.messages[0]?.content === 'Child inspection' || (Array.isArray(last?.content) && last.content.some(block => block.type === 'tool_result'))) {
    yield { type: 'text_delta', text: 'Inspection summary' };
    yield { type: 'done', response: { content: 'Inspection summary', stopReason: 'end_turn', toolCalls: [] } };
  } else yield { type: 'done', response: { content: null, stopReason: 'tool_use', toolCalls: [{ id: 'delegate-call', name: 'delegate_task', input: { task: 'Child inspection' } }] } };
} };

describe('child agent HTTP lifecycle and conversation pagination', () => {
  it('lets the main model delegate, waits for child tool evidence, and returns findings to the parent model', async () => {
    const parentRequests: any[] = []; const childRequests: any[] = [];
    const parent: LLMClient = { ...complete, async *stream(params) {
      parentRequests.push(structuredClone({ ...params, signal: undefined }));
      if (parentRequests.length === 1) yield { type: 'done', response: { content: null, stopReason: 'tool_use', toolCalls: [{ id: 'parent-delegation', name: 'delegate_task', input: { task: 'Inspect actors privately', specialist_id: 'director' } }] } };
      else { yield { type: 'text_delta', text: 'The inspection found Tree.' }; yield { type: 'done', response: { content: 'The inspection found Tree.', stopReason: 'end_turn', toolCalls: [] } }; }
    } };
    const child: LLMClient = { ...complete, async *stream(params) {
      childRequests.push(structuredClone({ ...params, signal: undefined }));
      if (childRequests.length === 1) yield { type: 'done', response: { content: null, stopReason: 'tool_use', toolCalls: [{ id: 'child-read', name: 'actor_list', input: {} }] } };
      else { yield { type: 'text_delta', text: 'Found Tree using actor_list.' }; yield { type: 'done', response: { content: 'Found Tree using actor_list.', stopReason: 'end_turn', toolCalls: [] } }; }
    } };
    const { post, url, store, configs, dispatch } = await start(parent, child);
    await post('/chat/config', { session_id: 'parent', provider: 'anthropic', model: 'test-model', api_key: 'parent-account-secret' });
    const response = await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate an actor inspection and explain the findings', mode: 'explore' });
    expect(response.status).toBe(200); const frames = await response.text();
    expect(parentRequests[0].tools.some((tool: { name: string }) => tool.name === 'delegate_task')).toBe(true);
    expect(childRequests).toHaveLength(2);
    expect(childRequests[0].messages).toEqual([{ role: 'user', content: 'Inspect actors privately' }]);
    expect(childRequests[0].tools.some((tool: { name: string }) => tool.name === 'delegate_task')).toBe(false);
    expect(dispatch).toHaveBeenCalledWith('actor_list', {});
    const parentResult = JSON.parse(parentRequests[1].messages.at(-1).content[0].content);
    expect(parentResult).toMatchObject({ status: 'succeeded', findings: 'Found Tree using actor_list.', specialist_id: 'director' });
    const { agents } = await fetch(`${url}/chat/sessions/parent/subagents`).then(res => res.json());
    expect(agents).toEqual([expect.objectContaining({ id: parentResult.agent_id, status: 'succeeded', tools: [{ id: 'child-read', name: 'actor_list', status: 'succeeded' }] })]);
    expect(store.load('parent')!.messages.map(message => message.content)).toEqual(['Delegate an actor inspection and explain the findings', 'The inspection found Tree.']);
    expect(configs).toHaveLength(2); expect(configs[1]).toMatchObject({ apiKey: 'parent-account-secret', model: 'test-model' });
    expect(frames).toContain('parent-delegation'); expect(frames).not.toContain('parent-account-secret');
    expect((await post('/chat/sessions/parent/subagents', { task: 'Removed manual launcher' })).status).toBe(404);
  });
  it('requires explicit ephemeral parent credentials despite persisted choices, global defaults and environment keys', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'environment-account-secret');
    const { post, store, configs } = await start(coordinator);
    store.replaceMessages('parent', [{ role: 'user', content: 'Restored conversation' }], { provider: 'anthropic', model: 'persisted-model', mode: 'explore', loop: 'community' });
    const turn = async () => (await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate inspection', mode: 'explore' })).text();
    const restored = await turn();
    expect(store.load('parent')!.subagents).toBeUndefined(); expect(configs).toHaveLength(1);
    await post('/chat/config', { provider: 'anthropic', model: 'global-model', api_key: 'global-account-secret' });
    const global = await turn();
    expect(store.load('parent')!.subagents).toBeUndefined(); expect(configs).toHaveLength(2);
    await post('/chat/config', { session_id: 'parent', provider: 'anthropic', model: 'parent-model' });
    const missingKey = await turn();
    expect(store.load('parent')!.subagents).toBeUndefined(); expect(configs).toHaveLength(3);
    await post('/chat/config', { session_id: 'parent', provider: 'anthropic', model: 'parent-model', api_key: 'parent-account-secret' });
    const explicit = await turn();
    expect(store.load('parent')!.subagents?.[0].status).toBe('succeeded'); expect(configs).toHaveLength(5);
    expect(configs[4]).toMatchObject({ provider: 'anthropic', model: 'parent-model', apiKey: 'parent-account-secret' });
    const responses = JSON.stringify([restored, global, missingKey, explicit]);
    for (const secret of ['environment-account-secret', 'global-account-secret', 'parent-account-secret']) expect(responses).not.toContain(secret);
  });
  it('guards child browsing and cancellation and exposes no manual launch endpoint', async () => {
    const stream = vi.fn(complete.stream);
    const { post, url } = await start({ ...complete, stream });
    await post('/chat/config', { session_id: 'parent', provider: 'mock' });
    expect((await fetch(`${url}/chat/sessions/parent/subagents`, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await post('/chat/sessions/parent/subagents/wrong/cancel', {}, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await fetch(`${url}/chat/sessions/missing/subagents`)).status).toBe(404);
    expect((await fetch(`${url}/chat/sessions/parent/subagents/wrong/cancel`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post('/chat/sessions/parent/subagents', { task: 'Removed launcher' })).status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
  });
  it.each(['parent', 'child'])('%s cancellation ends actual delegated work and releases the waiting parent', async target => {
    const blocked: LLMClient = { ...complete, async *stream(params) { await new Promise<void>(resolve => params.signal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); yield { type: 'text_delta', text: '' }; } };
    const { post, url, store } = await start(coordinator, blocked);
    await post('/chat/config', { session_id: 'parent', provider: 'mock' });
    const response = await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate inspection', mode: 'explore' });
    let agent: { id: string } | undefined;
    await vi.waitFor(async () => { const body = await fetch(`${url}/chat/sessions/parent/subagents`).then(res => res.json()); agent = body.agents[0]; expect(agent).toBeDefined(); });
    expect((await post(`/chat/sessions/other/subagents/${agent!.id}/cancel`, {})).status).toBe(404);
    expect((await fetch(`${url}/chat/sessions/parent`, { method: 'DELETE' })).status).toBe(409);
    expect((await post(target === 'parent' ? '/chat/cancel' : `/chat/sessions/parent/subagents/${agent!.id}/cancel`, target === 'parent' ? { session_id: 'parent' } : {})).status).toBe(200);
    const frames = await response.text(); expect(frames).toContain('event: done');
    expect(store.load('parent')!.subagents?.find(child => child.id === agent!.id)?.status).toBe('cancelled');
  });
  it('searches titles and pages the legacy sessions array with validated scalar parameters', async () => {
    const { store, url } = await start(complete);
    for (const id of ['parent', 'other']) store.append(id, { messages: [{ role: 'user', content: 'Inspect assets' }] });
    const first = await fetch(`${url}/chat/sessions?q=assets&limit=1&offset=0`).then(res => res.json());
    expect(first).toMatchObject({ total: 2, has_more: true, next_offset: 1 });
    expect(first.sessions).toHaveLength(1);
    const second = await fetch(`${url}/chat/sessions?q=assets&limit=1&offset=1`).then(res => res.json());
    expect(second).toMatchObject({ total: 2, has_more: false, next_offset: null });
    expect(second.sessions[0].id).not.toBe(first.sessions[0].id);
    for (const query of ['limit=51', 'offset=-1', 'limit=1&limit=2', 'q=a&q=b', `q=${'x'.repeat(257)}`]) expect((await fetch(`${url}/chat/sessions?${query}`)).status).toBe(400);
  });
  it('does not launch a child when cancellation arrives before the model delegation frame', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed: LLMClient = { ...complete, async *stream(params) { await gate; yield* coordinator.stream(params); } };
    const { post, store, configs } = await start(delayed, complete);
    await post('/chat/config', { session_id: 'parent', provider: 'mock' });
    const stream = await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate inspection', mode: 'explore' });
    await post('/chat/cancel', { session_id: 'parent' }); release();
    expect(await stream.text()).toContain('aborted');
    expect(configs).toHaveLength(1); expect(store.load('parent')!.subagents).toBeUndefined();
  });
  it('keeps delegated work running after an SSE disconnect and persists both completed findings and parent answer', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const child: LLMClient = { ...complete, async *stream(params) { await Promise.race([gate, new Promise<void>(resolve => params.signal!.addEventListener('abort', () => resolve(), { once: true }))]); yield* complete.stream(params); } };
    const { post, store, url } = await start(coordinator, child);
    await post('/chat/config', { session_id: 'parent', provider: 'mock' });
    const response = await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate inspection', mode: 'explore' });
    await vi.waitFor(async () => { const body = await fetch(`${url}/chat/sessions/parent/subagents`).then(res => res.json()); expect(body.agents[0]?.status).toBe('running'); });
    await response.body!.cancel();
    expect(store.load('parent')!.subagents).toBeUndefined();
    release();
    await vi.waitFor(() => expect(store.load('parent')!.subagents?.[0].status).toBe('succeeded'));
    await vi.waitFor(() => expect(store.load('parent')!.messages.at(-1)?.content).toBe('Inspection summary'));
  });
  it('does not bill a replacement account if parent credentials change before delegation', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed: LLMClient = { ...complete, async *stream(params) { await gate; yield* coordinator.stream(params); } };
    const { post, store, configs } = await start(delayed, complete);
    await post('/chat/config', { session_id: 'parent', provider: 'anthropic', api_key: 'first-account-secret' });
    const response = await post('/chat/stream', { session_id: 'parent', prompt: 'Delegate inspection', mode: 'explore' });
    await post('/chat/config', { session_id: 'parent', provider: 'anthropic', api_key: 'replacement-account-secret' });
    release(); const frames = await response.text();
    expect(configs).toHaveLength(1); expect(store.load('parent')!.subagents).toBeUndefined();
    expect(frames).toContain('Configure this conversation');
    expect(frames).not.toContain('first-account-secret'); expect(frames).not.toContain('replacement-account-secret');
  });
});
