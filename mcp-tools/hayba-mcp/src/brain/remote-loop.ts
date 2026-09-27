import type { AgentStreamEvent } from '@hayba/brain-protocol';
import { argsHash } from '@hayba/brain-protocol';
import type { LLMMessage } from '../agents/llm-client.js';
import { isDestructiveToolName, type DispatchTool } from '../chat/agent-loop.js';
import type { BrainSession } from './brain-session.js';
import { guardInboundToolCall, shapeToolResult, type GuardContext } from './hands-guard.js';
import type { LocalApprovals } from './local-approvals.js';

export interface RemoteLoopParams {
  session: BrainSession;
  messages: LLMMessage[];
  mode: 'explore' | 'draft' | 'production';
  pinnedSpecialistId?: string;
  activityTitle?: string;
  approvedCall?: { name: string; argsHash: string };
  approvals: LocalApprovals;
  dispatchTool: DispatchTool;
  guard: Omit<GuardContext, 'mode'>;
  signal: AbortSignal;
}

function isTerminal(e: AgentStreamEvent): boolean {
  return e.type === 'activity_completed' || e.type === 'approval_requested' || (e.type === 'error' && e.termination !== undefined);
}

export async function* runRemoteLoop(p: RemoteLoopParams): AsyncGenerator<AgentStreamEvent> {
  if (p.approvedCall) {
    p.approvals.add(p.approvedCall);
    p.session.send({ type: 'approve', name: p.approvedCall.name, args_hash: p.approvedCall.argsHash });
  } else {
    p.session.send({
      type: 'turn',
      messages: p.messages as Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>,
      mode: p.mode,
      ...(p.pinnedSpecialistId ? { pinned_specialist_id: p.pinnedSpecialistId } : {}),
      ...(p.activityTitle ? { activity_title: p.activityTitle } : {}),
    });
  }
  const onAbort = () => p.session.send({ type: 'cancel' });
  p.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const f of p.session.frames()) {
      if (f.type === 'event') {
        yield f.event;
        if (isTerminal(f.event)) return;
      } else if (f.type === 'tool_call') {
        p.session.send({ type: 'tool_result', id: f.id, ...(await executeLocally(p, f.name, f.args)) });
      } else if (f.type === 'done') {
        return;
      } else if (f.type === 'pro_unavailable') {
        yield { type: 'error', activityId: 'brain', error: f.message, kind: 'brain_unavailable' };
        return;
      }
    }
  } finally {
    p.signal.removeEventListener('abort', onAbort);
  }
}

async function executeLocally(
  p: RemoteLoopParams, name: string, args: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown; truncated?: boolean }> {
  const verdict = guardInboundToolCall(name, args, { ...p.guard, mode: p.mode });
  if (!verdict.ok) return { ok: false, result: { error: verdict.code, message: verdict.message } };
  if (isDestructiveToolName(name) && !p.approvals.consume(name, argsHash(args))) {
    return { ok: false, result: { error: 'approval_required', message: `${name} needs the user's approval in the Hayba panel` } };
  }
  try {
    const shaped = shapeToolResult(await p.dispatchTool(name, args));
    return { ok: true, result: shaped.result, truncated: shaped.truncated };
  } catch (err) {
    return { ok: false, result: { error: 'tool_failed', message: err instanceof Error ? err.message : String(err) } };
  }
}
