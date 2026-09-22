import { describe, expect, it } from 'vitest';
import { ActivityEventSchema, reduceActivity, type ActivityState, type AgentStreamEvent } from './activity-events.js';

const start = { type: 'activity_started', activityId: 'a1', title: 'Inspect world' } as const;
const call = { id: 'c1', name: 'actor_spawn', input: { label: 'Tree' } };
const approval = {
  type: 'approval_requested',
  activityId: 'a1',
  approvalId: 'p1',
  call,
  argsHash: '{"label":"Tree"}',
  source: 'ts',
} as const;
const complete = { type: 'activity_completed', activityId: 'a1', outcome: 'succeeded', reason: 'end_turn' } as const;
const running = { type: 'activity_step', activityId: 'a1', step: { status: 'running', ...call } } as const;
const finished = {
  type: 'activity_step',
  activityId: 'a1',
  step: { status: 'succeeded', id: 'c1', name: 'actor_spawn', result: { ok: true } },
} as const;

function replay(...events: AgentStreamEvent[]): ActivityState {
  return events.reduce<ActivityState | null>((state, event) => reduceActivity(state, event), null)!;
}

describe('ActivityEventSchema', () => {
  it('accepts every semantic event kind and rejects unknown fields at each structured boundary', () => {
    const events = [
      start,
      running,
      finished,
      approval,
      complete,
      { type: 'message_delta', activityId: 'a1', text: 'Hello' },
      { type: 'artifact_proposed', activityId: 'a1', artifact: { kind: 'plan', id: 'plan1', path: '/plans/1' } },
      {
        type: 'verdict_emitted',
        activityId: 'a1',
        verdict: { code: 'ready', message: 'Ready', severity: 'info', direction: 'proceed' },
      },
      { type: 'error', activityId: 'a1', error: 'Offline', kind: 'network' },
    ];
    for (const event of events) {
      expect(ActivityEventSchema.safeParse(event).success).toBe(true);
      expect(ActivityEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
    }
    for (const event of [
      { ...start, activityId: '' },
      { ...approval, call: { ...call, unexpected: true } },
      { ...running, step: { ...running.step, unexpected: true } },
      { ...complete, outcome: 'unknown' },
      { ...complete, usage: { inputTokens: -1 } },
      { ...complete, usage: { rawProviderData: 'secret' } },
    ])
      expect(ActivityEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('reduceActivity', () => {
  it('reduces planning, execution, artifacts, verdicts, and success without mutating prior state', () => {
    const planning = replay(start);
    expect(planning.status).toBe('planning');
    const active = reduceActivity(planning, running);
    expect(active.status).toBe('running');
    expect(planning.steps).toEqual([]);
    const result = [
      { type: 'message_delta', activityId: 'a1', text: 'Ready' },
      { type: 'artifact_proposed', activityId: 'a1', artifact: { kind: 'plan', id: 'plan1' } },
      {
        type: 'verdict_emitted',
        activityId: 'a1',
        verdict: { code: 'ready', message: 'Ready', severity: 'info', direction: 'proceed' },
      },
      finished,
      complete,
    ].reduce((state, event) => reduceActivity(state, ActivityEventSchema.parse(event)), active);
    expect(result).toMatchObject({
      status: 'succeeded',
      text: 'Ready',
      outcome: 'succeeded',
      artifacts: [{ id: 'plan1' }],
      verdicts: [{ code: 'ready' }],
      steps: [{ status: 'succeeded' }],
    });
    expect(active.steps[0].status).toBe('running');
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'rejects identical and conflicting completions after %s',
    (outcome) => {
      const terminal = { ...complete, outcome };
      const state = replay(start, terminal);
      expect(() => reduceActivity(state, terminal)).toThrowError(
        expect.objectContaining({ code: 'ACTIVITY_TERMINAL' }),
      );
      expect(() =>
        reduceActivity(state, { ...terminal, outcome: outcome === 'succeeded' ? 'failed' : 'succeeded' }),
      ).toThrowError(expect.objectContaining({ code: 'ACTIVITY_TERMINAL' }));
    },
  );

  it('pauses and resumes only with the matching approval identity', () => {
    const paused = replay(start, running, approval);
    expect(paused.status).toBe('awaiting_approval');
    expect(() => reduceActivity(paused, finished)).toThrowError(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
    expect(() => reduceActivity(paused, { ...start, resumeApprovalId: 'wrong' })).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_MISMATCH' }),
    );
    const resumed = reduceActivity(paused, { ...start, resumeApprovalId: 'p1' });
    expect(resumed.status).toBe('running');
    expect(resumed.approval).toBeUndefined();
    expect(resumed.steps).toEqual([]);
    expect(reduceActivity(reduceActivity(resumed, running), finished).steps[0].status).toBe('succeeded');
    expect(paused.approval?.approvalId).toBe('p1');
  });

  it.each(['planning', 'awaiting_approval', 'running'] as const)(
    'records cancellation from %s as a terminal result',
    (status) => {
      const state =
        status === 'planning'
          ? replay(start)
          : status === 'running'
            ? replay(start, running)
            : replay(start, running, approval);
      const cancelled = reduceActivity(state, {
        type: 'activity_completed',
        activityId: 'a1',
        outcome: 'cancelled',
        reason: 'aborted',
      });
      expect(cancelled).toMatchObject({ status: 'failed', outcome: 'cancelled' });
      expect(cancelled.approval).toBeUndefined();
      expect(() => reduceActivity(cancelled, running)).toThrowError(
        expect.objectContaining({ code: 'ACTIVITY_TERMINAL' }),
      );
    },
  );

  it('terminates on error and rejects further deltas', () => {
    const state = replay(start, running, approval, {
      type: 'error',
      activityId: 'a1',
      error: 'Disconnected',
      kind: 'network',
    });
    expect(state).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      error: { error: 'Disconnected', kind: 'network' },
    });
    expect(state.approval).toBeUndefined();
    expect(() => reduceActivity(state, complete)).toThrowError(expect.objectContaining({ code: 'ACTIVITY_TERMINAL' }));
    expect(() => reduceActivity(state, { type: 'message_delta', activityId: 'a1', text: 'oops' })).toThrowError(
      expect.objectContaining({ code: 'ACTIVITY_TERMINAL' }),
    );
  });

  it('rejects missing starts, duplicate starts, wrong activity IDs, and invalid step transitions with stable codes', () => {
    expect(() => reduceActivity(null, complete)).toThrowError(
      expect.objectContaining({ code: 'ACTIVITY_NOT_STARTED' }),
    );
    expect(() => reduceActivity(null, { ...start, resumeApprovalId: 'p1' })).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_MISMATCH' }),
    );
    const state = replay(start);
    expect(() => reduceActivity(state, start)).toThrowError(
      expect.objectContaining({ code: 'ACTIVITY_ALREADY_STARTED' }),
    );
    expect(() => reduceActivity(state, { ...running, activityId: 'other' })).toThrowError(
      expect.objectContaining({ code: 'ACTIVITY_ID_MISMATCH' }),
    );
    expect(() => reduceActivity(state, finished)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STEP_TRANSITION' }),
    );
    expect(() => reduceActivity(replay(start, running, finished), running)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STEP_TRANSITION' }),
    );
  });
});
