import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient, LLMTool } from '../agents/llm-client.js';
import { getAgentsManifest, resolveArchetype } from '../agents/agent-registry.js';
import { isExploreReadOnlyTool, shapeToolResult } from '../brain/hands-guard.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { DELEGATE_TASK_TOOL, runAgentLoop, type DispatchTool } from './agent-loop.js';
import { SessionStore, type SubagentRecord } from './session-store.js';

const taskSchema = z.strictObject({ task: z.string().trim().min(1).max(4000), specialist_id: z.string().min(1).max(128).optional() });
const WINDOW_MS = 10 * 60_000;
const terminal = (agent: SubagentRecord) => !['queued', 'running'].includes(agent.status);
export class SubagentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'SubagentError'; }
}
interface RunChild {
  client: LLMClient;
  tools: LLMTool[];
  dispatchTool: DispatchTool;
  secrets?: string[];
}

/** Real, isolated Community loops. Children can inspect; they cannot mutate or delegate. */
export class SubagentManager {
  private readonly active = new Map<string, { record: SubagentRecord; controller: AbortController; completion: Promise<SubagentRecord> }>();
  private readonly launches = new Map<string, number[]>();
  private readonly unsaved = new Map<string, SubagentRecord>();
  private readonly cancelledParents = new Set<string>();
  constructor(private readonly store: SessionStore, private readonly timeoutMs = 120_000) {}

  hasActive(parent: string): boolean { return [...this.active.values()].some(entry => entry.record.parent_session_id === parent); }
  resumeParent(parent: string): void { this.cancelledParents.delete(parent); }
  async wait(parent: string, id: string): Promise<SubagentRecord> {
    const active = this.active.get(id);
    if (active?.record.parent_session_id === parent) return active.completion;
    const record = this.list(parent).find(agent => agent.id === id);
    if (!record) throw new SubagentError('Unknown child task.', 404);
    return record;
  }
  list(parent: string): SubagentRecord[] {
    const records = new Map((this.store.load(parent)?.subagents ?? []).map(agent => [agent.id, agent]));
    for (const record of [...this.unsaved.values(), ...[...this.active.values()].map(entry => entry.record)])
      if (record.parent_session_id === parent) records.set(record.id, record);
    const sorted = [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return structuredClone([...sorted.filter(agent => !terminal(agent)), ...sorted.filter(terminal).slice(0, 30)]);
  }
  start(parent: string, input: unknown, params: RunChild): SubagentRecord {
    const parsed = taskSchema.safeParse(input);
    if (!parsed.success) throw new SubagentError('Provide a task of 1–4000 characters and a valid specialist profile.');
    if (!this.store.load(parent)) throw new SubagentError('Unknown parent conversation.', 404);
    if (this.cancelledParents.has(parent)) throw new SubagentError('This conversation was cancelled. Send a new parent message before starting another child task.', 409);
    const manifest = getAgentsManifest();
    const specialist_id = parsed.data.specialist_id ?? 'director';
    try { resolveArchetype(specialist_id, manifest); } catch { throw new SubagentError('Unknown specialist profile.'); }
    const now = Date.now();
    for (const [id, times] of this.launches) {
      const recent = times.filter(time => now - time < WINDOW_MS);
      if (recent.length) this.launches.set(id, recent); else this.launches.delete(id);
    }
    const recent = this.launches.get(parent) ?? [];
    if ([...this.active.values()].filter(entry => entry.record.parent_session_id === parent).length >= 3 || this.active.size >= 12 || recent.length >= 30)
      throw new SubagentError('Child task limit reached. Wait for a running task or the ten-minute launch window.', 429);
    const clean = (text: string, maxBytes: number): string => {
      let safe = text;
      for (const secret of params.secrets ?? []) if (secret) safe = safe.split(secret).join('[REDACTED:api_key]');
      // eslint-disable-next-line no-control-regex -- Strip unsafe controls while preserving tab, newline and carriage return.
      safe = redactSecrets(safe).value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      return Buffer.from(safe).subarray(0, maxBytes).toString('utf8');
    };
    const timestamp = new Date(now).toISOString();
    const record: SubagentRecord = { id: `agent_${randomUUID()}`, parent_session_id: parent, task: clean(parsed.data.task, 4096), specialist_id, status: 'running', created_at: timestamp, updated_at: timestamp, output: '', tools: [] };
    const controller = new AbortController();
    let complete!: (record: SubagentRecord) => void;
    const completion = new Promise<SubagentRecord>(resolve => { complete = resolve; });
    this.active.set(record.id, { record, controller, completion });
    this.launches.set(parent, [...recent, now]);
    const timer = setTimeout(() => controller.abort('deadline'), this.timeoutMs);
    timer.unref?.();
    const tools = params.tools.filter(tool => tool.name !== DELEGATE_TASK_TOOL && isExploreReadOnlyTool(tool.name));
    const allowed = new Set(tools.map(tool => tool.name));
    const dispatchTool: DispatchTool = async (name, args) => {
      if (controller.signal.aborted) throw new Error('Child task cancelled.');
      if (!allowed.has(name) || !isExploreReadOnlyTool(name)) throw new Error('Child tasks can only use available read-only tools.');
      let result = JSON.stringify(shapeToolResult(await params.dispatchTool(name, args)).result);
      for (const secret of params.secrets ?? []) if (secret) result = result.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED:api_key]');
      return JSON.parse(result);
    };
    // Run independently of sockets; parent delegation waits on completion while the roster stays live.
    void (async () => {
      try {
        for await (const event of runAgentLoop({ client: params.client, system: 'You are a delegated read-only inspection agent. Complete only the supplied task. Inspect with available tools, report evidence and limitations concisely, and never propose that an edit was executed. Do not delegate.', messages: [{ role: 'user', content: parsed.data.task }], tools, dispatchTool, manifest, pinnedSpecialistId: specialist_id, activityId: record.id, planMode: true, maxSteps: 12, tokenBudget: 16_000, maxTokens: 2048, signal: controller.signal })) {
          if (controller.signal.aborted) break;
          record.updated_at = new Date().toISOString();
          if (event.type === 'message_delta') {
            const combined = record.output + event.text;
            record.output = clean(combined, 4096);
            if (Buffer.byteLength(combined) > 4096) record.output_truncated = true;
          } else if (event.type === 'activity_step') {
            const id = clean(event.step.id, 128);
            const index = record.tools.findIndex(tool => tool.id === id);
            const tool = { id, name: clean(event.step.name, 128), status: event.step.status };
            if (index >= 0) record.tools[index] = tool;
            else if (record.tools.length < 16) record.tools.push(tool);
            else record.tools_truncated = true;
          } else if (event.type === 'approval_requested') {
            record.status = 'failed'; record.error = 'Child tasks cannot request edit approval. Run this work in the main conversation.';
            break;
          } else if (event.type === 'error') {
            record.status = 'failed'; record.error = 'The child provider or tool loop failed. Check the provider and try a narrower inspection task.';
          } else if (event.type === 'activity_completed') {
            record.status = event.outcome;
            if (event.outcome === 'failed') record.error = 'The child task stopped before completing. Try a narrower inspection task.';
          }
        }
        if (controller.signal.aborted) {
          record.status = controller.signal.reason === 'deadline' ? 'failed' : 'cancelled';
          if (controller.signal.reason === 'deadline') record.error = 'The child task reached its two-minute time limit.';
        } else if (!terminal(record)) { record.status = 'failed'; record.error = 'The child task ended without a completion result.'; }
      } catch {
        record.status = controller.signal.aborted ? 'cancelled' : 'failed';
        record.error = 'The child task could not complete.';
      } finally {
        clearTimeout(timer);
        record.updated_at = new Date().toISOString();
        for (const tool of record.tools) if (tool.status === 'running') tool.status = 'failed';
        try { this.store.append(parent, { subagent: record }); }
        catch {
          record.error = 'The child result could not be saved. It is available only until the sidecar restarts.';
          this.unsaved.set(record.id, record);
          if (this.unsaved.size > 12) this.unsaved.delete(this.unsaved.keys().next().value!);
        }
        this.active.delete(record.id);
        complete(structuredClone(record));
      }
    })();
    return structuredClone(record);
  }
  cancel(parent: string, id: string): SubagentRecord {
    const active = this.active.get(id);
    if (active?.record.parent_session_id === parent) { active.controller.abort(); return structuredClone(active.record); }
    const record = this.list(parent).find(agent => agent.id === id);
    if (!record) throw new SubagentError('Unknown child task.', 404);
    return record;
  }
  cancelParent(parent: string): number {
    this.cancelledParents.add(parent);
    let count = 0;
    for (const entry of this.active.values()) if (entry.record.parent_session_id === parent) { entry.controller.abort(); count++; }
    return count;
  }
  dispose(): void { for (const entry of this.active.values()) entry.controller.abort(); }
}
