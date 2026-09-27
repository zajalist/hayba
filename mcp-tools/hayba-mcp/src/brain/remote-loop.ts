import type { AgentStreamEvent, Frame } from '@hayba/brain-protocol';
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

type Race = { kind: 'frame'; result: IteratorResult<Frame> } | { kind: 'abort' };

export async function* runRemoteLoop(p: RemoteLoopParams): AsyncGenerator<AgentStreamEvent> {
  let lastActivityId = 'brain';
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

  let cancelSent = false;
  const sendCancelOnce = () => {
    if (cancelSent) return;
    cancelSent = true;
    p.session.send({ type: 'cancel' });
  };
  const aborted = new Promise<void>((resolve) => {
    if (p.signal.aborted) { resolve(); return; }
    p.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  p.signal.addEventListener('abort', sendCancelOnce, { once: true });

  const gen = p.session.frames();
  try {
    while (true) {
      // Race the next brain frame against a local abort: a disconnected or silent
      // brain must never keep this generator open once the caller has cancelled.
      const race = await Promise.race<Race>([
        gen.next().then((result) => ({ kind: 'frame', result })),
        aborted.then(() => ({ kind: 'abort' })),
      ]);
      if (race.kind === 'abort') {
        yield { type: 'activity_completed', activityId: lastActivityId, outcome: 'cancelled', reason: 'aborted' };
        return;
      }
      if (race.result.done) return;
      const f = race.result.value;
      if (f.type === 'event') {
        lastActivityId = f.event.activityId;
        yield f.event;
        if (isTerminal(f.event)) return;
      } else if (f.type === 'tool_call') {
        p.session.send({ type: 'tool_result', id: f.id, ...(await executeLocally(p, f.name, f.args)) });
      } else if (f.type === 'done') {
        return;
      } else if (f.type === 'pro_unavailable') {
        yield { type: 'error', activityId: lastActivityId, error: f.message, kind: 'brain_unavailable' };
        return;
      }
    }
  } finally {
    p.signal.removeEventListener('abort', sendCancelOnce);
  }
}

async function executeLocally(
  p: RemoteLoopParams, name: string, args: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown; truncated?: boolean }> {
  const verdict = guardInboundToolCall(name, args, { ...p.guard, mode: p.mode });
  if (!verdict.ok) return shaped(false, { error: verdict.code, message: verdict.message });
  if (isDestructiveToolName(name) && !p.approvals.consume(name, argsHash(args))) {
    return shaped(false, { error: 'approval_required', message: `${name} needs the user's approval in the Hayba panel` });
  }
  try {
    return shaped(true, await p.dispatchTool(name, args));
  } catch (err) {
    return shaped(false, { error: 'tool_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

/** Every outbound tool_result payload — success, refusal or failure — is redacted and size-capped. */
function shaped(ok: boolean, payload: unknown): { ok: boolean; result: unknown; truncated?: boolean } {
  const { result, truncated } = shapeToolResult(payload);
  return { ok, result, truncated };
}
