import { z, type ZodRawShape } from 'zod';
import { getRawShape } from '../../schema-registry.js';

export const invokeSchema = {
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
};

export type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: 'validation'; issues: unknown } }
  | { ok: false; error: { kind: 'tool_disabled'; name: string } }
  | { ok: false; error: { kind: 'unknown_tool'; name: string } };

export interface InvokeCtx {
  dispatch: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  isDisabled: (name: string) => boolean;
}

export async function invokeHandler(
  args: { name: string; args: Record<string, unknown> },
  ctx: InvokeCtx,
): Promise<InvokeResult> {
  if (ctx.isDisabled(args.name)) {
    return { ok: false, error: { kind: 'tool_disabled', name: args.name } };
  }
  const shape: ZodRawShape | null = getRawShape(args.name);
  if (!shape) {
    return { ok: false, error: { kind: 'unknown_tool', name: args.name } };
  }
  const parse = z.object(shape).safeParse(args.args);
  if (!parse.success) {
    return { ok: false, error: { kind: 'validation', issues: parse.error.issues } };
  }
  const result = await ctx.dispatch(args.name, parse.data as Record<string, unknown>);
  return { ok: true, result };
}

export const meta = {
  cost: 'medium' as const,
  effects: ['variable'],
  when: 'You need to call a tool that exists in an unloaded pack as a one-off.',
  not_when: 'You will call this tool repeatedly — load its pack instead.',
  pack: 'core',
};
