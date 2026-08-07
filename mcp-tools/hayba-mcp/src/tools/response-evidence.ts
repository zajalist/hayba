/**
 * Response-evidence contract.
 *
 * A mutation that reports `{"ok": true}` and nothing else is indistinguishable
 * from a mutation that silently did nothing. Every silent-success bug found in
 * this toolkit had that shape: the property was dropped, the key was ignored,
 * the asset was never dirtied — and the caller was told "ok". Nothing threw, so
 * nothing was noticed until someone looked at the editor and saw no change.
 *
 * The rule this module enforces is deliberately narrow, because a warning that
 * fires on healthy responses is its own kind of lie:
 *
 *   A tool that DECLARES an effect must return something that describes WHAT
 *   it did. Not proof — just evidence. Which keys applied, what the readback
 *   says, how many instances moved, the path that was written.
 *
 * Anything substantive counts. Only a payload that is bookkeeping and nothing
 * else — ok/status/message/timing — is treated as evidence-free, and that case
 * gets a warning block appended rather than being rewritten, so the tool's
 * existing response shape is preserved.
 *
 * Applied centrally at the registration seam (register-tool.ts), which is what
 * makes this affordable: the ~57 hand-written passthrough wrappers become
 * honest without editing 57 files, and any tool added later is covered the day
 * it is registered rather than the day someone remembers this rule.
 */

import type { RichToolResult, ToolResult, ToolTextContent } from './types.js';

/**
 * Keys that carry no information about what a mutation actually did.
 *
 * Kept deliberately TIGHT. Every key omitted here is a key that counts as
 * evidence, and a false "no evidence" warning on a healthy response would train
 * the reader to ignore the warning — which costs more than the rule buys.
 * When unsure whether a key is substantive, leave it out of this set.
 */
const BOOKKEEPING_KEYS = new Set([
  'ok',
  'success',
  'status',
  'message',
  'msg',
  'note',
  'command',
  'cmd',
  'tool',
  'elapsed_ms',
  'duration_ms',
  'took_ms',
  'timestamp',
]);

/** Marker text, exported so tests and callers can detect the annotation. */
export const UNVERIFIED_MUTATION_WARNING =
  'UNVERIFIED: this tool declares that it changes state, but its response describes ' +
  'no change — it carries only status/bookkeeping fields. That is the exact shape a ' +
  'silently-ignored parameter produces, so success here is NOT confirmation. Read the ' +
  'affected state back before reporting this as done, and if the tool should be naming ' +
  'what it applied (changed_keys / unchanged_keys / readback), treat this as a gap in ' +
  'the tool rather than a fact about the world.';

/**
 * True when a parsed payload says something about what happened.
 *
 * Presence of a substantive key is enough — the VALUE may legitimately be empty.
 * `{"changed_keys": []}` is not evidence-free: it is an explicit, honest report
 * that nothing applied, which is precisely the signal this contract exists to
 * preserve. Demanding a non-empty value would suppress the most useful answer a
 * mutation can give.
 */
export function hasMutationEvidence(payload: unknown): boolean {
  // A non-object payload (array of results, a returned id, a path string) is
  // itself the evidence.
  if (payload === null || payload === undefined) return false;
  if (Array.isArray(payload)) return true;
  if (typeof payload !== 'object') return true;

  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (!BOOKKEEPING_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Parse a result's first text block as JSON, or undefined when it is not JSON.
 *
 * Tools that return prose, or an image block, are outside this contract: there
 * is no reliable way to tell an evidence-free prose reply from a detailed one,
 * and guessing would produce exactly the noisy false positives this module is
 * trying to avoid.
 */
function parsePayload(result: RichToolResult): unknown | undefined {
  if (!Array.isArray(result.content)) return undefined;
  // Only text blocks carry a payload; an image block is the picture, not the
  // report, so it is skipped rather than treated as missing evidence.
  const first = result.content.find((c): c is ToolTextContent => c.type === 'text');
  if (!first || typeof first.text !== 'string') return undefined;
  try {
    return JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

/**
 * Append the unverified-mutation warning when a mutating tool returned a
 * response with no evidence of what it changed.
 *
 * Additive and idempotent, mirroring withValidationNudge: the original content
 * block is untouched so no caller's parsing breaks, and the warning rides
 * alongside as a trailing text block.
 *
 * No-ops on error results (an error is already an honest report of failure) and
 * on non-JSON / image results (outside the contract, see parsePayload).
 */
export function withEvidenceWarning<T extends RichToolResult>(result: T): T {
  if (result.isError) return result;
  if (!Array.isArray(result.content)) return result;

  const already = result.content.some(
    (c) => c.type === 'text' && typeof c.text === 'string' && c.text.includes(UNVERIFIED_MUTATION_WARNING),
  );
  if (already) return result;

  const payload = parsePayload(result);
  if (payload === undefined) return result;
  if (hasMutationEvidence(payload)) return result;

  return {
    ...result,
    content: [...result.content, { type: 'text' as const, text: UNVERIFIED_MUTATION_WARNING }],
  };
}

/**
 * Whether a tool's declared effects put it under this contract.
 *
 * Broader than isSceneMutating: writing an asset to disk, editing a material
 * graph or saving a widget all change state the caller cares about, even though
 * none of them place anything in the world. Any declared effect at all means
 * the tool claims to change something, and a claim to change something is a
 * claim that can be silently false.
 */
export function isUnderEvidenceContract(effects: string[] | undefined): boolean {
  return Array.isArray(effects) && effects.length > 0;
}

/**
 * Recover a tool's effect tags from its rendered description.
 *
 * Not all registration paths carry a HaybaToolMeta object to the seam: most of
 * the hand-written sites in index.ts call server.tool(...) with an already
 * appendMeta'd description and never register meta under the tool's name. Those
 * tools would otherwise sit outside the contract purely because of how they
 * happen to be registered, which is the wrong reason for a rule to not apply.
 *
 * describeMeta always renders `[effects=[a,b]]`, so the description is a
 * dependable second source. Returns undefined when the marker is absent, which
 * the caller must treat as "unknown" rather than "no effects" — assuming a tool
 * is read-only because we failed to parse it is exactly the silent-success
 * failure this module exists to prevent.
 */
export function parseEffectsFromDescription(description: string | undefined): string[] | undefined {
  if (!description) return undefined;
  const m = /\[effects=\[([^\]]*)\]\]/.exec(description);
  if (!m) return undefined;
  return (m[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Wrap a handler so its result is checked against the evidence contract.
 *
 * Tolerant of handlers that return something other than a ToolResult (rich
 * results with image blocks, or nothing at all): those pass through untouched
 * rather than throwing, because a contract that can break a working tool is
 * worse than one with a gap.
 */
export function guardHandlerWithEvidence<T extends (...args: never[]) => unknown>(handler: T): T {
  return (async (...args: never[]) => {
    const result = await handler(...args);
    if (!result || typeof result !== 'object') return result;
    if (!Array.isArray((result as ToolResult).content)) return result;
    return withEvidenceWarning(result as ToolResult);
  }) as unknown as T;
}
