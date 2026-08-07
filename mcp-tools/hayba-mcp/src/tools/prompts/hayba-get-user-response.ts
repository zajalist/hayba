import { z } from 'zod';
import { executeCommand } from '../tool-executor.js';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'polling for the answer to a prompt previously pushed via hayba_request_input',
  not_when: 'pushing a new prompt — use hayba_request_input',
};

export const getUserResponseSchema = z.object({
  prompt_id: z.string().min(1),
  wait_ms: z.number().int().min(0).max(300_000).optional()
    .describe('How long the UE side should block waiting for an answer. Default 0 (non-blocking poll).'),
});

export type GetUserResponseParams = z.infer<typeof getUserResponseSchema>;

export type UserResponseStatus = 'pending' | 'answered' | 'rejected' | 'timeout' | 'unknown';

export interface UserResponse {
  prompt_id: string;
  status: UserResponseStatus;
  value?: unknown;
  error?: string;
}

export const haybaGetUserResponseHandler: ToolHandler = async (args) => {
  const parsed = getUserResponseSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const waitMs = parsed.data.wait_ms ?? 0;
  // TCP request timeout has to outlive the UE-side wait, plus a margin.
  const tcpTimeoutMs = Math.max(5000, waitMs + 2000);
  try {
    // A UE-reported failure and a transport failure produced identical bodies
    // here, so routing through the seam (which throws on both) collapses the
    // two branches into the catch below rather than losing a case.
    const data = await executeCommand(
      'hayba_get_user_response',
      { prompt_id: parsed.data.prompt_id, wait_ms: waitMs },
      { timeout: tcpTimeoutMs },
    );
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e: unknown) {
    const body: UserResponse = { prompt_id: parsed.data.prompt_id, status: 'unknown', error: e instanceof Error ? e.message : String(e) };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
};
