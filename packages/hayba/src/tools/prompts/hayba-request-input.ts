import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ensureConnected } from '../../tcp-client.js';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['user_input'],
  when: 'you need a decision, free-text answer, multi-option choice, or progress display surfaced in the UE Plan tab',
  not_when: 'requesting approval of a destructive plan — use hayba_propose_plan',
};

export const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  image_base64: z.string().optional(),
});

export const formFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'long_text', 'number', 'bool', 'enum']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
});

export const requestInputSchema = z.object({
  kind: z.enum(['approve', 'choose_one', 'choose_many', 'text', 'form', 'progress']),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(optionSchema).optional(),
  fields: z.array(formFieldSchema).optional(),
  progress: z.object({
    value: z.number().min(0).max(1),
    message: z.string().optional(),
  }).optional(),
  prompt_id: z.string().optional().describe('Optional caller-supplied UUID. Auto-generated when absent.'),
});

export type RequestInputParams = z.infer<typeof requestInputSchema>;

/**
 * Validates the cross-field contract: every prompt kind has a different
 * "required payload" — choose_* needs options, form needs fields, etc.
 * Returns an error message when the contract is violated, or null when ok.
 */
export function validateKindPayload(p: RequestInputParams): string | null {
  switch (p.kind) {
    case 'approve':
    case 'text':
      return null;
    case 'choose_one':
    case 'choose_many':
      if (!p.options || p.options.length === 0) {
        return `kind=${p.kind} requires non-empty 'options'`;
      }
      return null;
    case 'form':
      if (!p.fields || p.fields.length === 0) return "kind='form' requires non-empty 'fields'";
      return null;
    case 'progress':
      if (!p.progress) return "kind='progress' requires 'progress'";
      return null;
  }
}

export const haybaRequestInputHandler: ToolHandler = async (args) => {
  const parsed = requestInputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const contractErr = validateKindPayload(parsed.data);
  if (contractErr) {
    return { content: [{ type: 'text', text: `Validation error: ${contractErr}` }], isError: true };
  }

  const promptId = parsed.data.prompt_id ?? randomUUID();
  const payload = { ...parsed.data, prompt_id: promptId };

  try {
    const client = await ensureConnected();
    const resp = await client.send('hayba_request_input', payload as unknown as Record<string, unknown>, 5000);
    const body = resp.ok
      ? { prompt_id: promptId, status: 'pushed', ...(resp.data as Record<string, unknown> | undefined) }
      : { prompt_id: promptId, status: 'push_failed', error: resp.error };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: !resp.ok };
  } catch (e: unknown) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ prompt_id: promptId, status: 'push_failed', error: e instanceof Error ? e.message : String(e) }, null, 2) }],
      isError: true,
    };
  }
};
