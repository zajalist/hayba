// Pre-flight validator wrapper for python_run.
//
// We DO NOT edit `python/python-run.ts` directly — sibling PR2 owns that file.
// Instead this module exposes a wrapped handler that:
//   1. Pre-checks the script for the self-socket pattern.
//   2. On match: REJECTS the call (returns an error result with a validator
//      finding embedded) — this is the only safe behaviour because the script
//      would otherwise deadlock UE on the game thread.
//   3. Otherwise delegates to the original pythonRunHandler.
//
// TODO(validator-wire-up): once PR2 is merged this logic should live inline
// in python-run.ts and the wrapper file can be removed.

import { z } from 'zod';
import type { ToolHandler } from './types.js';
import { pythonRunHandler, schema as pythonRunSchema } from './python/python-run.js';
import { emitDirectFinding, isSelfSocketScript } from '../validator/index.js';
import { attachFindingsToResponse } from '../validator/response.js';
import { runAfterTool } from '../validator/runner.js';
import { join } from 'node:path';

export const wrappedPythonRunSchema = pythonRunSchema;

interface WrapOpts {
  scratchDir?: string;
}

export function makeValidatedPythonRunHandler(opts: WrapOpts = {}): ToolHandler {
  const scratchDir = opts.scratchDir ?? join(process.cwd(), '.scratch');

  return async (rawArgs, _session) => {
    const parsed = z.object(pythonRunSchema.shape).safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }],
        isError: true,
      };
    }
    const args = parsed.data;

    // ── Pre-flight: self-socket → hard reject ───────────────────────────
    if (isSelfSocketScript(args.script)) {
      const finding = await emitDirectFinding({
        ruleId: 'tcp_socket_to_self_in_python_run',
        severity: 'error',
        message: 'python_run script opens a TCP socket to the UE plugin port (would deadlock)',
        hint: 'Use the Python plugin API (`unreal.*`) directly instead of round-tripping through the TCP server (52342–52350).',
        refs: ['[[python-run-no-self-connect]]'],
        context: { script_preview: args.script.slice(0, 200) },
        toolName: 'python_run',
      });
      return attachFindingsToResponse(
        {
          content: [{
            type: 'text',
            text: 'python_run rejected by validator: script would open a TCP socket back to the UE plugin port, which deadlocks the game thread.',
          }],
          isError: true,
        },
        [finding],
      );
    }

    // ── Delegate to the real handler ─────────────────────────────────────
    const result = await pythonRunHandler(args as unknown as Record<string, unknown>, _session ?? {});

    // ── Post-condition: any other rules that target python_run ──────────
    const findings = await runAfterTool({
      toolName: 'python_run',
      toolArgs: args as unknown as Record<string, unknown>,
      toolResult: result,
      ue: null, // no follow-up UE queries needed for self-socket post-cond
      scratchDir,
    });
    return attachFindingsToResponse(result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean }, findings);
  };
}
