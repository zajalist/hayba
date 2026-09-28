import { z } from 'zod';
import { DirectionalVerdictSchema, ResourceRefSchema } from './workflow-refs.js';

const id = z.string().min(1);
const identity = { activityId: id };
const callFields = { id, name: id, input: z.record(z.string(), z.unknown()) };
const resultFields = { id, name: id, result: z.unknown() };
export const StepSchema = z.discriminatedUnion('status', [
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

export const TerminationSchema = z
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
      'wall_clock',
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
  z
    .object({
      type: z.literal('activity_started'),
      ...identity,
      title: id,
      resumeApprovalId: id.optional(),
      specialistId: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal('activity_step'), ...identity, step: StepSchema, specialistId: id.optional() }).strict(),
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
