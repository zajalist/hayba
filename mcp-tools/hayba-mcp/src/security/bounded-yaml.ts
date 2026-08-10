import { Buffer } from 'node:buffer';
import { CORE_SCHEMA, YAMLException, load as loadYaml } from 'js-yaml';

/**
 * Deliberately conservative YAML 1.2 policy for Hayba-owned configuration.
 *
 * These inputs are small, hand-authored data files. They do not need aliases,
 * merge keys, legacy YAML 1.1 tags, or deeply nested flow collections. Keeping
 * those features out makes parsing cost proportional to the already-bounded
 * input size and prevents two callers from quietly choosing different YAML
 * semantics.
 */
export const HAYBA_YAML_MAX_DEPTH = 32;
export const HAYBA_YAML_MAX_ALIASES = 0;
export const HAYBA_YAML_MAX_TOTAL_MERGE_KEYS = 0;

export type BoundedYamlErrorCode = 'empty_input' | 'input_too_large' | 'invalid_yaml' | 'merge_key_not_supported';

export class BoundedYamlError extends Error {
  constructor(
    public readonly code: BoundedYamlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BoundedYamlError';
  }
}

export interface BoundedYamlOptions {
  /** A fixed, non-user-controlled label used in safe diagnostics. */
  label: string;
  maxBytes: number;
}

/** Parse one YAML 1.2 CORE document without returning parser snippets.
 *
 * js-yaml's detailed exception contains a source excerpt. That is excellent
 * for a local YAML editor and unsafe at an MCP/CLI boundary where the document
 * can contain credentials. We retain only its line/column coordinates.
 */
export function parseBoundedYaml(raw: string, options: BoundedYamlOptions): unknown {
  const inputBytes = Buffer.byteLength(raw, 'utf8');
  if (inputBytes === 0 || raw.trim().length === 0) {
    throw new BoundedYamlError('empty_input', `${options.label} is empty`);
  }
  if (inputBytes > options.maxBytes) {
    throw new BoundedYamlError('input_too_large', `${options.label} exceeds the ${options.maxBytes}-byte input limit`);
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(raw, {
      schema: CORE_SCHEMA,
      json: false,
      maxDepth: HAYBA_YAML_MAX_DEPTH,
      maxAliases: HAYBA_YAML_MAX_ALIASES,
      maxTotalMergeKeys: HAYBA_YAML_MAX_TOTAL_MERGE_KEYS,
    });
  } catch (error) {
    const location = safeLocation(error);
    throw new BoundedYamlError('invalid_yaml', `${options.label} is invalid YAML${location}`);
  }

  // CORE_SCHEMA treats `<<` as an ordinary string key. Reject it explicitly
  // rather than letting a future schema change silently enable merge behavior.
  if (containsMergeKey(parsed)) {
    throw new BoundedYamlError('merge_key_not_supported', `${options.label} uses the unsupported YAML merge key "<<"`);
  }

  return parsed;
}

function safeLocation(error: unknown): string {
  if (!(error instanceof YAMLException) || !error.mark) return '';
  return ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}`;
}

function containsMergeKey(root: unknown): boolean {
  if (root === null || typeof root !== 'object') return false;

  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const value of current) {
        if (value !== null && typeof value === 'object') pending.push(value);
      }
      continue;
    }

    for (const key of Object.keys(current)) {
      if (key === '<<') return true;
      const value = (current as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object') pending.push(value);
    }
  }
  return false;
}
