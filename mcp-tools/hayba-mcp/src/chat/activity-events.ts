import type { z } from 'zod';
import {
  ActivityEventSchema,
  StepSchema,
  ResourceRefSchema,
  DirectionalVerdictSchema,
  type AgentStreamEvent,
} from '@hayba/brain-protocol';

export { ActivityEventSchema, type AgentStreamEvent };
type EventOf<T extends AgentStreamEvent['type']> = Extract<AgentStreamEvent, { type: T }>;

export interface ActivityState {
  activityId: string;
  title: string;
  status: 'planning' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed';
  text: string;
  steps: Array<z.infer<typeof StepSchema>>;
  artifacts: Array<z.infer<typeof ResourceRefSchema>>;
  verdicts: Array<z.infer<typeof DirectionalVerdictSchema>>;
  approval?: EventOf<'approval_requested'>;
  outcome?: 'succeeded' | 'failed' | 'cancelled';
  completion?: EventOf<'activity_completed'>;
  error?: EventOf<'error'>;
}

export type ActivityTransitionErrorCode =
  | 'ACTIVITY_NOT_STARTED'
  | 'ACTIVITY_ALREADY_STARTED'
  | 'ACTIVITY_ID_MISMATCH'
  | 'ACTIVITY_TERMINAL'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_MISMATCH'
  | 'INVALID_STEP_TRANSITION';

export class ActivityTransitionError extends Error {
  constructor(readonly code: ActivityTransitionErrorCode) {
    super(code);
    this.name = 'ActivityTransitionError';
  }
}

function reject(code: ActivityTransitionErrorCode): never {
  throw new ActivityTransitionError(code);
}

/**
 * Pure single-activity reducer; null denotes an activity not started yet.
 * Resume is explicit and bound to the pending approval ID. It represents an
 * already authorized resume, not an authorization decision or tool dispatch.
 * Every event after termination is rejected, including identical completions.
 */
export function reduceActivity(state: ActivityState | null, input: AgentStreamEvent): ActivityState {
  const event = ActivityEventSchema.parse(input);
  if (!state) {
    if (event.type !== 'activity_started') return reject('ACTIVITY_NOT_STARTED');
    if (event.resumeApprovalId) return reject('APPROVAL_MISMATCH');
    return {
      activityId: event.activityId,
      title: event.title,
      status: 'planning',
      text: '',
      steps: [],
      artifacts: [],
      verdicts: [],
    };
  }
  if (state.activityId !== event.activityId) return reject('ACTIVITY_ID_MISMATCH');
  if (state.status === 'succeeded' || state.status === 'failed') {
    return reject('ACTIVITY_TERMINAL');
  }
  switch (event.type) {
    case 'activity_started':
      if (state.status !== 'awaiting_approval') return reject('ACTIVITY_ALREADY_STARTED');
      if (event.resumeApprovalId !== state.approval?.approvalId) return reject('APPROVAL_MISMATCH');
      // The gated call never executed. Retire that request before the resumed
      // model turn re-announces it (possibly with a new provider call ID).
      return {
        ...state,
        status: 'running',
        approval: undefined,
        steps: state.steps.filter((step) => step.id !== state.approval?.call.id || step.status !== 'running'),
      };
    case 'message_delta':
      return { ...state, text: state.text + event.text };
    case 'activity_step': {
      if (state.status === 'awaiting_approval') return reject('APPROVAL_REQUIRED');
      const index = state.steps.findIndex((step) => step.id === event.step.id);
      if (
        event.step.status === 'running'
          ? index !== -1
          : index === -1 || state.steps[index].status !== 'running' || state.steps[index].name !== event.step.name
      ) {
        return reject('INVALID_STEP_TRANSITION');
      }
      const steps = [...state.steps];
      if (index === -1) steps.push(event.step);
      else steps[index] = event.step;
      return { ...state, status: 'running', steps };
    }
    case 'approval_requested':
      if (state.status === 'awaiting_approval') return reject('APPROVAL_REQUIRED');
      return { ...state, status: 'awaiting_approval', approval: event };
    case 'artifact_proposed':
      return { ...state, artifacts: [...state.artifacts, event.artifact] };
    case 'verdict_emitted':
      return { ...state, verdicts: [...state.verdicts, event.verdict] };
    case 'activity_completed':
      if (state.status === 'awaiting_approval' && event.outcome === 'succeeded') return reject('APPROVAL_REQUIRED');
      return {
        ...state,
        status: event.outcome === 'succeeded' ? 'succeeded' : 'failed',
        outcome: event.outcome,
        completion: event,
        approval: undefined,
      };
    case 'error':
      return { ...state, status: 'failed', outcome: 'failed', error: event, approval: undefined };
  }
}
