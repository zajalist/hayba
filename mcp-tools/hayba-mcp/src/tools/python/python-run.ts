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

// Mirror the native Tier-3 classifier for immediate sidecar feedback. The C++
// handler remains authoritative because its bounded alias expansion can see
// indirect spellings that this direct-source mirror cannot. Keep this list in
// parity with FHaybaMCPPythonHandler::ClassifyScript.
const TIER3_SOURCE_PATTERNS = [
  'subprocess',
  'os.system',
  'os.popen',
  'os.remove(',
  'os.unlink(',
  'os.rename(',
  'os.renames(',
  'os.replace(',
  'os.mkdir(',
  'os.makedirs(',
  'os.rmdir(',
  'os.removedirs(',
  'os.truncate(',
  'os.chmod(',
  'os.chown(',
  'os.lchown(',
  'os.link(',
  'os.symlink(',
  'os.mknod(',
  '.write_text(',
  '.write_bytes(',
  '.unlink(',
  '.rename(',
  '.replace(',
  '.mkdir(',
  '.rmdir(',
  '.touch(',
  '.chmod(',
  '.lchmod(',
  '.symlink_to(',
  '.hardlink_to(',
  'open(',
  '__import__',
  'eval(',
  'compile(',
  'shutil',
  'importsocket',
  'socket.socket',
] as const;

function compactPythonPolicySource(script: string): string {
  return script
    .replace(/\\\r?\n/g, '')
    .replace(/\r?\n/g, ';')
    .replace(/"/g, "'")
    .replace(/\s/g, '')
    .toLowerCase();
}

function findDirectTier3Pattern(script: string): string | undefined {
  const compact = compactPythonPolicySource(script);
  return TIER3_SOURCE_PATTERNS.find((pattern) => compact.includes(compactPythonPolicySource(pattern)));
}

function tier3RefusalFacts(allowUnsafeRequested: boolean): Record<string, unknown> {
  return {
    policy_code: 'HCR-SANDBOX-001',
    matched_rule: 'tier_3_filesystem_or_subprocess',
    tier: 3,
    policy_phase: 'pre_execute',
    allow_unsafe_requested: allowUnsafeRequested,
    allow_unsafe_effective: false,
    allow_unsafe_deprecated: true,
    retry_unchanged: 'forbidden',
    safety_boundary: 'classification_only_not_process_isolation',
    tracking_issues: ['#392', '#414'],
  };
}

function tier3RefusalMessage(allowUnsafeRequested: boolean): string {
  return (
    "python_run policy_blocked [HCR-SANDBOX-001]: matched 'tier_3_filesystem_or_subprocess'. " +
    'Tier-3 host filesystem, subprocess, and network access is unavailable from embedded python_run. ' +
    `Facts: tier:3, policy_phase:pre_execute, allow_unsafe_requested:${allowUnsafeRequested}, ` +
    'allow_unsafe_effective:false, allow_unsafe_deprecated:true. ' +
    'Safe alternative: use a typed brokered MCP tool (#412/#415). Retry unchanged: forbidden. ' +
    'This classification boundary does not claim arbitrary in-process Python safety; isolation remains tracked by #392/#414.'
  );
}

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
  // All embedded-Python policy is non-bypassable. `allow_unsafe` remains in
  // the wire schema only so older callers receive a stable, explicit refusal.
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
  const allowUnsafeRequested = parsed.data.allow_unsafe === true;
  const tier3Pattern = findDirectTier3Pattern(script);
  if (tier3Pattern) {
    return errorResult(tier3RefusalMessage(allowUnsafeRequested), {
      ...tier3RefusalFacts(allowUnsafeRequested),
      matched_primitive: tier3Pattern,
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
    // Never forward the deprecated compatibility field as authority. Native
    // C++ independently refuses Tier 3 for direct/stale callers.
    const payload: Record<string, unknown> = { script };
    const data = await executeCommand<Record<string, unknown>>('python_run', payload);
    // The sidecar intentionally strips the compatibility field before the
    // native call, so restore truthful caller-observation facts on the reply.
    // These are facts about authority, not a claim that arbitrary embedded
    // Python is process-isolated (#392/#414).
    const responseData = {
      ...data,
      allow_unsafe_requested: allowUnsafeRequested,
      allow_unsafe_effective: false,
      allow_unsafe_deprecated: true,
    };
    const text = JSON.stringify(responseData, null, 2);
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
      return errorResult(`${tier3RefusalMessage(allowUnsafeRequested)} Underlying error: ${nativeError}`, {
        ...tier3RefusalFacts(allowUnsafeRequested),
      });
    }
    const policyCode = /\[(HCR-[A-Z]+-\d{3})\]/.exec(nativeError)?.[1];
    if (policyCode) {
      return errorResult(nativeError, {
        policy_code: policyCode,
        retry_unchanged: 'forbidden',
        ...(policyCode === 'HCR-SANDBOX-001' ? tier3RefusalFacts(allowUnsafeRequested) : {}),
      });
    }
    return errorResult(`python_run error: ${nativeError}`);
  }
};
