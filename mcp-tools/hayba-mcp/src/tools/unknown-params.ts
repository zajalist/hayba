// Tell the caller when a parameter was ignored.
//
// Zod's `object()` STRIPS unknown keys rather than rejecting them, and almost
// none of the tool schemas are `.strict()`. So a misspelled optional parameter
// silently disappears and the call reports success:
//
//     actor_spawn({ class_path: ..., location: [...], rotaton: [0,45,0] })
//       -> spawns at the DEFAULT rotation, returns ok
//
// The agent asked for a 45-degree rotation, got zero, and was told everything
// worked. Verified against a live editor, not inferred: `rotaton` and an
// invented `banana` were both accepted without complaint.
//
// This warns rather than refuses, deliberately. Refusing would be the stricter
// contract, but unknown keys are legitimately present today — alias resolution
// passes both spellings, and callers send extra context on some paths — so
// flipping to `.strict()` across ~410 tools would break working callers to fix
// a reporting problem. A warning is honest and costs nothing when clean.

import type { RichToolResult, ToolTextContent } from './types.js';

/** Keys that are plumbing rather than tool parameters. */
const NON_PARAMETER_KEYS = new Set([
  'session_id',
  'sessionId',
  '_meta',
  'signal',
]);

/**
 * Which of `params` are not named by the schema.
 *
 * `known` should include every accepted spelling: the canonical schema keys,
 * the wire-schema keys where they differ, and any alias targets. A key counted
 * as unknown when it is actually accepted would train readers to ignore this.
 */
export function unknownParamKeys(
  params: Record<string, unknown>,
  known: Iterable<string>,
): string[] {
  const accept = new Set(known);
  return Object.keys(params)
    .filter((k) => !accept.has(k))
    .filter((k) => !NON_PARAMETER_KEYS.has(k))
    .sort();
}

/** Append a note naming the ignored keys. Returns the result untouched when clean. */
export function withUnknownParamWarning(
  result: RichToolResult,
  unknown: string[],
  accepted: Iterable<string>,
): RichToolResult {
  if (unknown.length === 0) return result;

  const acceptedList = [...accepted].sort().join(', ');
  const note: ToolTextContent = {
    type: 'text',
    text:
      `\n[ignored] ${unknown.length === 1 ? 'Parameter' : 'Parameters'} ` +
      `${unknown.map((k) => `"${k}"`).join(', ')} ` +
      `${unknown.length === 1 ? 'is' : 'are'} not part of this tool's schema and ` +
      `${unknown.length === 1 ? 'was' : 'were'} dropped before the call — the result ` +
      `above did NOT take ${unknown.length === 1 ? 'it' : 'them'} into account. ` +
      `Accepted: ${acceptedList}.`,
  };

  return { content: [...result.content, note], isError: result.isError };
}
