import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { MAX_PYTHON_SCRIPT_CHARS, scanPythonForCrashers, crashGuardMessage } from '../guards/known-crashers.js';
import { errorResult } from '../tool-result.js';
import { resolveAliases } from '../param-aliases.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

/**
 * When python_run output exceeds this many characters, spill the full payload
 * to a temp file and return a head + the path, instead of letting the transport
 * layer truncate it mid-output. See HANDOFF postmortem P1.
 */
const STDOUT_SPILL_THRESHOLD = 12_000;

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['runs_arbitrary_python', 'unknown_side_effects'],
  when: "executing a Python script via UE's PythonScriptPlugin for tasks not exposed by other commands",
  not_when: 'an existing actor_/asset_/blueprint_ command can do the job — prefer those',
};

export const schema = z.object({
  script: z.string().min(1),
  allow_unsafe: z.boolean().optional(),
});

export const pythonRunHandler: ToolHandler = async (args) => {
  const resolved = resolveAliases(args, TOOL_ALIASES.python_run);
  if (!resolved.ok) {
    return errorResult(`Validation error: ${resolved.error}`);
  }
  const parsed = schema.safeParse(resolved.args);
  if (!parsed.success) {
    return errorResult(`Validation error: ${parsed.error.message}`);
  }
  const script = (parsed.data as { script: string }).script;
  if (script.length > MAX_PYTHON_SCRIPT_CHARS) {
    return errorResult(
      `python_run policy_blocked [HCR-SIZE-001]: script is ${script.length} characters; limit is ${MAX_PYTHON_SCRIPT_CHARS}. Split the work into bounded requests. Retry unchanged: forbidden.`,
      {
        policy_code: 'HCR-SIZE-001',
        matched_rule: 'script_size',
        retry_unchanged: 'forbidden',
        limit_chars: MAX_PYTHON_SCRIPT_CHARS,
      },
    );
  }
  // Crash guards are non-bypassable. `allow_unsafe` controls Tier-3 policy;
  // it is not permission to deadlock or terminate the editor.
  const hit = scanPythonForCrashers(script);
  if (hit) {
    return errorResult(crashGuardMessage(hit), {
      policy_code: hit.code,
      matched_rule: hit.pattern,
      policy_family: hit.family,
      safe_alternative: hit.alternative,
      retry_unchanged: 'forbidden',
    });
  }
  try {
    // Send the raw script. The UE handler now captures print()/stderr itself
    // (it injects a capturing print into the user code's exec globals) and
    // returns them in the stdout/stderr fields. Wrapping here too would
    // double-exec and route print to the log stream instead of the return value
    // — see the 2026-06-18 python_run stdout investigation. The old exported
    // print wrapper was removed: it hid source in exec(compile(...)), directly
    // conflicting with the authoritative HCR-DYNAMIC-001 boundary.
    const payload: Record<string, unknown> = {
      ...(parsed.data as Record<string, unknown>),
    };
    const data = await executeCommand<Record<string, unknown>>('python_run', payload);
    const text = JSON.stringify(data, null, 2);
    if (text.length > STDOUT_SPILL_THRESHOLD) {
      // Auto-spill: write the full payload to a temp file and return a head +
      // path so large dumps (pin lists, asset inventories) survive intact
      // instead of being truncated downstream.
      try {
        const dir = join(tmpdir(), 'hayba-python');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `python_run-${Date.now()}.json`);
        writeFileSync(file, text);
        const head = text.slice(0, STDOUT_SPILL_THRESHOLD);
        return {
          content: [
            {
              type: 'text',
              text: `${head}\n\n…[output truncated: ${text.length} chars]\nFull output written to: ${file}\nRead that file to get the complete result.`,
            },
          ],
        };
      } catch {
        // Spill failed — fall through to returning the (large) text as-is.
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    // The seam throws on a UE-reported failure and carries the original native
    // response as uePayload. Preserve native HCR codes and recovery text: the
    // C++ boundary is authoritative for stale/direct clients and for runtime
    // deadline/SEH failures that TypeScript cannot predict.
    const uePayload = (e as { uePayload?: unknown })?.uePayload as
      | { data?: Record<string, unknown>; error?: string }
      | undefined;
    const nativeError = uePayload?.error ?? (e instanceof Error ? e.message : String(e));
    if (uePayload?.data?.tier === 3 && !nativeError.includes('[HCR-')) {
      return errorResult(
        `python_run policy_blocked [HCR-SANDBOX-001]: matched 'tier_3_filesystem_or_subprocess'. ` +
          `A detected filesystem or subprocess primitive is disabled by default. Safe alternative: use a typed MCP tool, or set ` +
          `bAllowUnsafePython=true / pass allow_unsafe:true after reviewing the script. ` +
          `Retry unchanged: forbidden; underlying error: ${nativeError}`,
        {
          policy_code: 'HCR-SANDBOX-001',
          tier: 3,
          retry_unchanged: 'forbidden',
          retry_with_allow_unsafe: 'permitted_after_review',
        },
      );
    }
    const policyCode = /\[(HCR-[A-Z]+-\d{3})\]/.exec(nativeError)?.[1];
    if (policyCode) {
      return errorResult(nativeError, {
        policy_code: policyCode,
        retry_unchanged: 'forbidden',
        ...(policyCode === 'HCR-SANDBOX-001' ? { tier: 3, retry_with_allow_unsafe: 'permitted_after_review' } : {}),
      });
    }
    return errorResult(`python_run error: ${nativeError}`);
  }
};
