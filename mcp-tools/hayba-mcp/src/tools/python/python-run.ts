import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { MAX_PYTHON_SCRIPT_CHARS, scanPythonForCrashers, crashGuardMessage } from '../guards/known-crashers.js';
import { errorResult } from '../tool-result.js';
import { resolveAliases } from '../param-aliases.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

// Keep each rendered stream below this many JSON-encoded characters. Two
// streams plus facts remain comfortably below the central redactor's 64 KiB
// per-string boundary. This is an in-memory presentation cap: raw native output
// must never be persisted before the shared secret-redaction boundary (#383).
const MCP_STREAM_JSON_CHAR_LIMIT = 12_000;

interface BoundedCapturedStream {
  value: string;
  mcpTruncated: boolean;
  mcpCharsDropped: number;
}

/** Return the longest prefix whose JSON string literal fits the wire budget. */
function boundCapturedStream(value: unknown): BoundedCapturedStream {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (JSON.stringify(text).length <= MCP_STREAM_JSON_CHAR_LIMIT) {
    return { value: text, mcpTruncated: false, mcpCharsDropped: 0 };
  }

  // Binary search avoids assuming one source character maps to one serialized
  // character: quotes, controls, and lone surrogates expand under JSON escaping.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, middle)).length <= MCP_STREAM_JSON_CHAR_LIMIT) low = middle;
    else high = middle - 1;
  }
  const valuePrefix = text.slice(0, low);
  return {
    value: valuePrefix,
    mcpTruncated: true,
    mcpCharsDropped: text.length - valuePrefix.length,
  };
}

function nonnegativeNativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

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
    const stdout = boundCapturedStream(data.stdout);
    const stderr = boundCapturedStream(data.stderr);
    const stdoutNativeTruncated = data.stdout_truncated === true;
    const stderrNativeTruncated = data.stderr_truncated === true;
    const stdoutNativeCharsDropped = nonnegativeNativeCount(data.stdout_chars_dropped);
    const stderrNativeCharsDropped = nonnegativeNativeCount(data.stderr_chars_dropped);
    const outputTruncated =
      stdoutNativeTruncated || stderrNativeTruncated || stdout.mcpTruncated || stderr.mcpTruncated;
    const responseData = {
      ...data,
      stdout: stdout.value,
      stderr: stderr.value,
      // Preserve the native 64 KiB capture facts separately, then expose the
      // aggregate facts callers historically read. A partial reply can never
      // masquerade as complete merely because truncation happened in Node.
      stdout_native_truncated: stdoutNativeTruncated,
      stderr_native_truncated: stderrNativeTruncated,
      stdout_native_chars_dropped: stdoutNativeCharsDropped,
      stderr_native_chars_dropped: stderrNativeCharsDropped,
      stdout_mcp_truncated: stdout.mcpTruncated,
      stderr_mcp_truncated: stderr.mcpTruncated,
      stdout_mcp_chars_dropped: stdout.mcpCharsDropped,
      stderr_mcp_chars_dropped: stderr.mcpCharsDropped,
      stdout_truncated: stdoutNativeTruncated || stdout.mcpTruncated,
      stderr_truncated: stderrNativeTruncated || stderr.mcpTruncated,
      stdout_chars_dropped: stdoutNativeCharsDropped + stdout.mcpCharsDropped,
      stderr_chars_dropped: stderrNativeCharsDropped + stderr.mcpCharsDropped,
      mcp_result_truncated: stdout.mcpTruncated || stderr.mcpTruncated,
      output_truncated: outputTruncated,
      output_complete: !outputTruncated,
      mcp_stream_limit_serialized_chars: MCP_STREAM_JSON_CHAR_LIMIT,
      mcp_output_policy: 'bounded_inline_no_filesystem_spill',
      allow_unsafe_requested: allowUnsafeRequested,
      allow_unsafe_effective: false,
      allow_unsafe_deprecated: true,
    };
    const text = JSON.stringify(responseData, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    // The seam throws on a UE-reported failure and carries the original native
    // response as uePayload. Preserve native HCR codes and recovery text: the
    // C++ boundary is authoritative for stale/direct clients and for runtime
    // deadline/SEH failures that TypeScript cannot predict.
    const uePayload = (e as { uePayload?: unknown })?.uePayload as
      { data?: Record<string, unknown>; error?: string } | undefined;
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
