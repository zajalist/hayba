import { z } from 'zod';
import { DirectionalVerdictSchema, ResourceRefSchema } from '../tools/workflows/contracts.js';

const id = z.string().min(1);
const identity = { activityId: id };
const callFields = { id, name: id, input: z.record(z.string(), z.unknown()) };
const resultFields = { id, name: id, result: z.unknown() };
const StepSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), ...callFields }).strict(),
  z.object({ status: z.literal('succeeded'), ...resultFields }).strict(),
  z.object({ status: z.literal('failed'), ...resultFields }).strict(),
]);

const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    cacheReadInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

const TerminationSchema = z
  .object({
    reason: z.enum([
      'end_turn',
      'max_tokens',
      'context_window_exceeded',
      'provider_refusal',
      'provider_protocol_error',
      'provider_stop',
      'max_steps',
      'token_budget',
      'aborted',
    ]),
    stopReason: z
      .enum([
        'end_turn',
        'tool_use',
        'max_tokens',
        'stop_sequence',
        'pause_turn',
        'refusal',
        'model_context_window_exceeded',
        'content_filter',
        'unknown',
      ])
      .optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

/** Provider-neutral stream contract. Raw step payloads are transient, never persistence records. */
export const ActivityEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_delta'), ...identity, text: z.string() }).strict(),
  z.object({ type: z.literal('activity_started'), ...identity, title: id, resumeApprovalId: id.optional() }).strict(),
  z.object({ type: z.literal('activity_step'), ...identity, step: StepSchema }).strict(),
  z
    .object({
      type: z.literal('approval_requested'),
      ...identity,
      approvalId: id,
      call: z.object(callFields).strict(),
      argsHash: id,
      source: z.enum(['ts', 'ue']),
      hint: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('artifact_proposed'), ...identity, artifact: ResourceRefSchema }).strict(),
  z.object({ type: z.literal('verdict_emitted'), ...identity, verdict: DirectionalVerdictSchema }).strict(),
  z
    .object({
      type: z.literal('activity_completed'),
      ...identity,
      outcome: z.enum(['succeeded', 'failed', 'cancelled']),
      ...TerminationSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      ...identity,
      error: z.string(),
      kind: id.optional(),
      termination: TerminationSchema.optional(),
    })
    .strict(),
]);

export type AgentStreamEvent = z.infer<typeof ActivityEventSchema>;
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
