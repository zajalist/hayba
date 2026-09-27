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
  /** Called with the brain's reason just before a `brain_unavailable` error is yielded. */
  onUnavailable?: (reason: string) => void;
}

/** An outcome for the current activity — the turn itself only ends at the `done` frame. */
function isTerminal(e: AgentStreamEvent): boolean {
  return e.type === 'activity_completed' || (e.type === 'error' && e.termination !== undefined);
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

  // A local abort must both tell the brain (`cancel`) and tell OUR session that
  // this turn is dead, so the session absorbs its stragglers instead of leaking
  // them into whatever turn runs next on the same (reused) BrainSession.
  const cancelLocally = () => {
    p.session.send({ type: 'cancel' });
    p.session.cancelTurn();
  };

  if (p.signal.aborted) {
    // AbortSignal never fires 'abort' for a signal that was already aborted
    // before we started listening, so this must be handled up front.
    cancelLocally();
    yield { type: 'activity_completed', activityId: lastActivityId, outcome: 'cancelled', reason: 'aborted' };
    return;
  }

  let cancelSent = false;
  const sendCancelOnce = () => {
    if (cancelSent) return;
    cancelSent = true;
    cancelLocally();
  };
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
  const onAbort = () => resolveAborted();
  p.signal.addEventListener('abort', sendCancelOnce, { once: true });
  p.signal.addEventListener('abort', onAbort, { once: true });

  // Protocol rule (binding): every brain turn ends with exactly one `done` frame;
  // `done`, not an activity outcome, is the turn boundary. Once the activity has
  // reached an outcome we stop yielding further events but keep reading (and
  // still answering any tool_call) until `done` closes the turn out — otherwise
  // `done` is left in the inbox for the NEXT turn on this reused session to trip
  // over. `approval_requested` is the one exception: the brain PARKS the turn
  // there (no `done` follows), so we return immediately; the eventual `approve`
  // call reopens the same turn and is the one that consumes through its `done`.
  let awaitingDone = false;

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
      if (race.result.done) {
        // The frame stream ended (session closed/gave up) without a `done` frame.
        if (p.signal.aborted) yield { type: 'activity_completed', activityId: lastActivityId, outcome: 'cancelled', reason: 'aborted' };
        return;
      }
      const f = race.result.value;
      if (f.type === 'event') {
        lastActivityId = f.event.activityId;
        if (f.event.type === 'approval_requested') {
          yield f.event;
          return;
        }
        if (!awaitingDone) yield f.event; // stray events after the outcome are defensively ignored
        if (isTerminal(f.event)) awaitingDone = true;
      } else if (f.type === 'tool_call') {
        p.session.send({ type: 'tool_result', id: f.id, ...(await executeLocally(p, f.name, f.args)) });
      } else if (f.type === 'done') {
        return;
      } else if (f.type === 'pro_unavailable') {
        p.onUnavailable?.(f.reason);
        yield { type: 'error', activityId: lastActivityId, error: f.message, kind: 'brain_unavailable' };
        return;
      } else if (f.type === 'upgrade_required') {
        p.onUnavailable?.('upgrade_required');
        yield { type: 'error', activityId: lastActivityId, error: `Update Hayba to use Pro: ${f.download_url}`, kind: 'brain_unavailable' };
        return;
      }
    }
  } finally {
    p.signal.removeEventListener('abort', sendCancelOnce);
    p.signal.removeEventListener('abort', onAbort);
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
