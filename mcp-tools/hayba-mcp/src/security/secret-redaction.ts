import type { Express, NextFunction, Request, Response } from 'express';

export type SecretCategory =
  | 'api_key'
  | 'authorization'
  | 'bearer'
  | 'credential'
  | 'password'
  | 'private_key'
  | 'provider_key'
  | 'token'
  | 'url_query';

export type TruncationReason =
  | 'accessor'
  | 'array_items'
  | 'cycle'
  | 'depth'
  | 'nodes'
  | 'object_keys'
  | 'string_chars'
  | 'total_string_chars';

const SECRET_CATEGORIES: readonly SecretCategory[] = [
  'api_key',
  'authorization',
  'bearer',
  'credential',
  'password',
  'private_key',
  'provider_key',
  'token',
  'url_query',
];

const TRUNCATION_REASONS: readonly TruncationReason[] = [
  'accessor',
  'array_items',
  'cycle',
  'depth',
  'nodes',
  'object_keys',
  'string_chars',
  'total_string_chars',
];

export interface SecretRedactionSummary {
  applied: boolean;
  redacted_values: number;
  categories: SecretCategory[];
  truncated: boolean;
  truncation_reasons: TruncationReason[];
}

export interface SecretRedactionResult<T> {
  value: T;
  summary: SecretRedactionSummary;
}

export interface SecretRedactionOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxKeyChars?: number;
  maxStringChars?: number;
  maxTotalStringChars?: number;
}

const DEFAULTS: Required<SecretRedactionOptions> = {
  maxDepth: 16,
  maxNodes: 10_000,
  maxArrayItems: 256,
  maxObjectKeys: 256,
  maxKeyChars: 256,
  maxStringChars: 64 * 1_024,
  maxTotalStringChars: 1 * 1_024 * 1_024,
};

const REDACTED_PREFIX = '[REDACTED:';
const TRUNCATED_PREFIX = '[TRUNCATED:';
const SECURITY_META_KEY = 'hayba/security_redaction';
const CONSOLE_INSTALLED = Symbol.for('hayba.consoleSecretRedactionInstalled');
const JSON_WRAPPED_RESPONSES = new WeakSet<object>();

const MEASUREMENT_HEADS = new Set([
  'age', 'algorithm', 'allowed', 'at', 'budget', 'count', 'date', 'depth',
  'disabled', 'duration', 'enabled', 'error', 'expired', 'format', 'found',
  'id', 'index', 'kind', 'label', 'last4', 'length', 'limit', 'max', 'message',
  'min', 'missing', 'mode', 'name', 'offset', 'order', 'policy', 'position',
  'present', 'reason', 'remaining', 'required', 'rule', 'scheme', 'size',
  'source', 'state', 'status', 'supported', 'time', 'timestamp', 'total',
  'ttl', 'type', 'used', 'valid', 'version',
]);

const SECRET_COMPOUNDS: ReadonlyArray<[string, SecretCategory]> = [
  ['authorization', 'authorization'],
  ['proxyauthorization', 'authorization'],
  ['privatekey', 'private_key'],
  ['signingkey', 'private_key'],
  ['clientsecret', 'credential'],
  ['webhooksecret', 'credential'],
  ['accesskey', 'credential'],
  ['apikey', 'api_key'],
  ['accesstoken', 'token'],
  ['refreshtoken', 'token'],
  ['authtoken', 'token'],
  ['bearertoken', 'token'],
  ['password', 'password'],
  ['passwd', 'password'],
  ['pwd', 'password'],
  ['credential', 'credential'],
  ['secretkey', 'credential'],
  ['token', 'token'],
  ['secret', 'credential'],
];

// Every pattern runs only after the input string is bounded. None contains a
// nested quantifier or an unbounded alternation over attacker-controlled text.
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+\/=:-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PROVIDER_KEY = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g;
const URL_SECRET = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|signature|sig|x-amz-signature|x-amz-credential)=)([^&#\s]+)/gi;
const URL_USERINFO = /(\bhttps?:\/\/[^\s\/@:]+:)([^\s\/@]+)(@)/gi;
const ASSIGNMENT = /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key|password|passwd|pwd|token|secret|authorization|credential|x-api-key|cookie|set-cookie)["']?\s*[:=]\s*["']?)([^"'&,;\s}\]]+)/gi;

interface WalkState {
  options: Required<SecretRedactionOptions>;
  nodes: number;
  stringChars: number;
  active: WeakSet<object>;
  categories: Set<SecretCategory>;
  truncationReasons: Set<TruncationReason>;
  redactedValues: number;
}

interface WalkResult<T> {
  value: T;
  changed: boolean;
}

/** Non-mutating, bounded, cycle-safe redaction of an arbitrary response value. */
export function redactSecrets<T>(value: T, options: SecretRedactionOptions = {}): SecretRedactionResult<T> {
  const bounded = validateOptions({ ...DEFAULTS, ...options });
  const state: WalkState = {
    options: bounded,
    nodes: 0,
    stringChars: 0,
    active: new WeakSet(),
    categories: new Set(),
    truncationReasons: new Set(),
    redactedValues: 0,
  };
  const walked = walk(value, state, 0, false);
  return {
    value: walked.value,
    summary: summaryOf(state),
  };
}

/** Add a serializable machine fact when redaction/truncation changed a boundary value. */
export function redactBoundaryValue<T>(value: T): T {
  const result = redactSecrets(value);
  if (!result.summary.applied && !result.summary.truncated) return result.value;
  return attachObjectFact(result.value, '_security_redaction', result.summary);
}

/** MCP-specific form uses `_meta`, leaving content/errors/recovery in place. */
export function redactMcpResult<T>(value: T): T {
  const result = redactSecrets(value);
  if (!result.summary.applied && !result.summary.truncated) return result.value;
  if (!isRecord(result.value) || Array.isArray(result.value)) return result.value;
  const currentMeta = isRecord(result.value._meta) ? result.value._meta : {};
  return cloneWithProperty(result.value, '_meta', cloneWithProperty(currentMeta, SECURITY_META_KEY, result.summary)) as T;
}

/** Preserve Error type while ensuring SDK error serialization and stacks are safe. */
export function redactThrown(error: unknown): unknown {
  try {
    return redactThrownInner(error, new WeakSet());
  } catch {
    return new Error(`${TRUNCATED_PREFIX}accessor]`);
  }
}

function redactThrownInner(error: unknown, active: WeakSet<object>): unknown {
  if (!(error instanceof Error)) return redactBoundaryValue(error);
  if (active.has(error)) return `${TRUNCATED_PREFIX}cycle]`;
  active.add(error);
  const message = redactSecrets(error.message).value;
  const stack = typeof error.stack === 'string' ? redactSecrets(error.stack).value : undefined;
  const causeDescriptor = Object.getOwnPropertyDescriptor(error, 'cause');
  const causeWasAccessor = !!causeDescriptor && !('value' in causeDescriptor);
  const rawCause = causeDescriptor && 'value' in causeDescriptor ? causeDescriptor.value : undefined;
  const cause = causeWasAccessor
    ? `${TRUNCATED_PREFIX}accessor]`
    : rawCause === undefined ? undefined : redactThrownInner(rawCause, active);
  const details = Object.keys(error).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    const hasValue = !!descriptor && 'value' in descriptor;
    const wasAccessor = !hasValue;
    const raw = hasValue ? descriptor.value : `${TRUNCATED_PREFIX}accessor]`;
    return [key, raw, redactBoundaryValue(raw), wasAccessor] as const;
  });
  const detailsChanged = details.some(([, raw, safe, wasAccessor]) => wasAccessor || safe !== raw);
  if (message === error.message && stack === error.stack && !causeWasAccessor && cause === rawCause && !detailsChanged) {
    active.delete(error);
    return error;
  }
  const safe = new Error(message, cause === undefined ? undefined : { cause });
  safe.name = error.name;
  if (stack) safe.stack = stack;
  for (const [key, , detail] of details) {
    Object.defineProperty(safe, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: detail,
    });
  }
  active.delete(error);
  return safe;
}

/** Install once at process startup so dynamic stderr arguments cannot bypass policy. */
export function installConsoleSecretRedaction(): void {
  const tagged = console as Console & { [CONSOLE_INSTALLED]?: boolean };
  if (tagged[CONSOLE_INSTALLED]) return;
  for (const level of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = ((...args: unknown[]) => original(...args.map(redactThrown))) as typeof console[typeof level];
  }
  Object.defineProperty(tagged, CONSOLE_INSTALLED, { value: true, enumerable: false });
}

/** Wrap Express `res.json` once; safe for overlapping app- and route middleware. */
export function installExpressJsonRedaction(app: Express, path?: string): void {
  // Some in-process capability probes pass a registration-only stand-in with
  // `get`/`post` but no middleware stack. It cannot emit HTTP by itself, so
  // there is no response boundary to wrap.
  if (typeof (app as { use?: unknown }).use !== 'function') return;
  const middleware = (_req: Request, res: Response, next: NextFunction): void => {
    if (!JSON_WRAPPED_RESPONSES.has(res)) {
      const original = res.json.bind(res);
      res.json = ((body?: unknown) => original(redactBoundaryValue(body))) as Response['json'];
      JSON_WRAPPED_RESPONSES.add(res);
    }
    next();
  };
  if (path) app.use(path, middleware);
  else app.use(middleware);
}

function walk<T>(value: T, state: WalkState, depth: number, opaque: boolean): WalkResult<T> {
  state.nodes += 1;
  if (state.nodes > state.options.maxNodes) return truncated(state, 'nodes') as WalkResult<T>;
  if (depth > state.options.maxDepth) return truncated(state, 'depth') as WalkResult<T>;

  if (typeof value === 'string') {
    return walkString(value, state, opaque) as WalkResult<T>;
  }
  if (value === null || typeof value !== 'object') return { value, changed: false };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return { value, changed: false };
  }
  if (state.active.has(value)) return truncated(state, 'cycle') as WalkResult<T>;

  state.active.add(value);
  try {
    if (Array.isArray(value)) return walkArray(value, state, depth) as WalkResult<T>;
    try {
      return walkObject(value as Record<string, unknown>, state, depth) as WalkResult<T>;
    } catch {
      // Proxies can throw from ownKeys/getOwnPropertyDescriptor. Returning the
      // subtree unread would bypass redaction; fail closed without echoing the
      // hostile exception text.
      return truncated(state, 'accessor') as WalkResult<T>;
    }
  } finally {
    state.active.delete(value);
  }
}

function walkArray(value: unknown[], state: WalkState, depth: number): WalkResult<unknown[]> {
  const limit = Math.min(value.length, state.options.maxArrayItems);
  let changed = value.length > limit;
  if (changed) state.truncationReasons.add('array_items');
  const output: unknown[] = [];
  for (let i = 0; i < limit; i += 1) {
    const next = walk(value[i], state, depth + 1, false);
    output.push(next.value);
    changed ||= next.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function walkObject(value: Record<string, unknown>, state: WalkState, depth: number): WalkResult<Record<string, unknown>> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) entries.push([key, descriptor.value]);
    else {
      entries.push([key, `${TRUNCATED_PREFIX}accessor]`]);
      state.truncationReasons.add('accessor');
    }
  }
  const limit = Math.min(entries.length, state.options.maxObjectKeys);
  let changed = entries.length > limit;
  if (changed) state.truncationReasons.add('object_keys');
  const output: Record<string, unknown> = {};
  const selected = selectObjectEntries(entries, limit);
  const reservedKeys = new Set(entries.map(([key]) => key));
  const emittedKeys = new Set<string>();

  for (let i = 0; i < selected.length; i += 1) {
    const [rawKey, rawValue] = selected[i]!;
    const category = secretCategoryForKey(rawKey);
    let key = rawKey;
    const keySecret = inspectPropertyKey(rawKey, state);
    if (keySecret) {
      key = uniquePropertyPlaceholder(`_redacted_key_${keySecret}_${i}`, reservedKeys, emittedKeys);
      changed = true;
    } else if (rawKey.length > state.options.maxKeyChars) {
      key = uniquePropertyPlaceholder(`_truncated_key_${i}`, reservedKeys, emittedKeys);
      state.truncationReasons.add('object_keys');
      changed = true;
    }

    let next: WalkResult<unknown>;
    if (category && !isRedactedMarker(rawValue)) {
      state.categories.add(category);
      state.redactedValues += 1;
      next = { value: marker(category), changed: true };
    } else {
      next = walk(rawValue, state, depth + 1, isOpaquePayload(rawKey, value));
    }
    defineSafe(output, key, next.value);
    emittedKeys.add(key);
    changed ||= next.changed || key !== rawKey;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function selectObjectEntries(entries: Array<[string, unknown]>, limit: number): Array<[string, unknown]> {
  if (entries.length <= limit) return entries;
  const chosen = new Set<number>();
  for (let i = 0; i < entries.length && chosen.size < limit; i += 1) {
    if (isMandatoryOutputKey(entries[i]![0])) chosen.add(i);
  }
  for (let i = 0; i < entries.length && chosen.size < limit; i += 1) chosen.add(i);
  return [...chosen].sort((a, b) => a - b).map((index) => entries[index]!);
}

function isMandatoryOutputKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return normalized === 'error'
    || normalized === 'errors'
    || normalized === 'mandatoryrecovery'
    || normalized === 'recovery'
    || normalized === 'recoveryaction'
    || normalized === 'recoveryactions';
}

function walkString(value: string, state: WalkState, opaque: boolean): WalkResult<string> {
  if (isRedactedMarker(value) || isTruncationMarker(value)) return { value, changed: false };
  // Binary/base64 payloads retain exact bytes; transport response limits remain
  // their allocation boundary. Secret-named keys are masked before this point.
  if (opaque) return { value, changed: false };

  let text = value;
  let changed = false;
  const remaining = Math.max(0, state.options.maxTotalStringChars - state.stringChars);
  const allowed = Math.min(state.options.maxStringChars, remaining);
  if (text.length > allowed) {
    text = `${text.slice(0, Math.max(0, allowed))}${TRUNCATED_PREFIX}string_chars]`;
    state.truncationReasons.add(remaining < state.options.maxStringChars ? 'total_string_chars' : 'string_chars');
    changed = true;
  }
  state.stringChars += Math.min(text.length, allowed);

  const privateKey = redactPrivateKeyBlocks(text, state);
  text = privateKey.value;
  changed ||= privateKey.changed;
  ({ text, changed } = replaceSecrets(text, BEARER, 'bearer', changed, state));
  ({ text, changed } = replaceSecrets(text, JWT, 'token', changed, state));
  ({ text, changed } = replaceSecrets(text, PROVIDER_KEY, 'provider_key', changed, state));
  ({ text, changed } = replaceMiddleGroup(text, URL_USERINFO, 'password', changed, state));
  ({ text, changed } = replaceValueGroup(text, URL_SECRET, 'url_query', changed, state));
  ({ text, changed } = replaceValueGroup(text, ASSIGNMENT, 'credential', changed, state));
  return changed ? { value: text, changed: true } : { value, changed: false };
}

function replaceMiddleGroup(
  input: string,
  pattern: RegExp,
  category: SecretCategory,
  changed: boolean,
  state: WalkState,
): { text: string; changed: boolean } {
  const text = input.replace(pattern, (match, prefix: string, raw: string, suffix: string) => {
    if (isRedactedMarker(raw)) return match;
    state.categories.add(category);
    state.redactedValues += 1;
    return `${prefix}${marker(category)}${suffix}`;
  });
  return { text, changed: changed || text !== input };
}

function replaceSecrets(
  input: string,
  pattern: RegExp,
  category: SecretCategory,
  changed: boolean,
  state: WalkState,
): { text: string; changed: boolean } {
  const text = input.replace(pattern, (match) => {
    if (isRedactedMarker(match)) return match;
    state.categories.add(category);
    state.redactedValues += 1;
    return marker(category);
  });
  return { text, changed: changed || text !== input };
}

function replaceValueGroup(
  input: string,
  pattern: RegExp,
  category: SecretCategory,
  changed: boolean,
  state: WalkState,
): { text: string; changed: boolean } {
  const text = input.replace(pattern, (match, prefix: string, raw: string) => {
    // Assignment values stop before a JSON/object closing bracket. A marker
    // therefore arrives here without its own final `]`; recognizing precisely
    // that complete adjacent marker keeps a second pass idempotent without
    // blessing attacker-controlled marker prefixes.
    if (isRedactedMarker(raw) || isRedactedMarker(`${raw}]`)) return match;
    state.categories.add(category);
    state.redactedValues += 1;
    return `${prefix}${marker(category)}`;
  });
  return { text, changed: changed || text !== input };
}

function redactPrivateKeyBlocks(input: string, state: WalkState): { value: string; changed: boolean } {
  const terminal = 'PRIVATE KEY-----';
  let output = '';
  let cursor = 0;
  let changed = false;
  while (cursor < input.length) {
    const begin = input.indexOf('-----BEGIN ', cursor);
    if (begin < 0) { output += input.slice(cursor); break; }
    const headerEnd = input.indexOf(terminal, begin);
    if (headerEnd < 0 || headerEnd - begin > 80) { output += input.slice(cursor, begin + 11); cursor = begin + 11; continue; }
    const end = input.indexOf(terminal, headerEnd + terminal.length);
    if (end < 0) { output += input.slice(cursor, begin); output += marker('private_key'); cursor = input.length; }
    else { output += input.slice(cursor, begin); output += marker('private_key'); cursor = end + terminal.length; }
    state.categories.add('private_key');
    state.redactedValues += 1;
    changed = true;
  }
  return { value: changed ? output : input, changed };
}

function secretCategoryForKey(key: string): SecretCategory | undefined {
  const bounded = key.length > 1_024 ? `${key.slice(0, 512)}${key.slice(-512)}` : key;
  const words = bounded
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const last = words.at(-1);
  if (last && MEASUREMENT_HEADS.has(last)) return undefined;
  const normalized = words.join('');
  if ([...MEASUREMENT_HEADS].some((head) => normalized !== head && normalized.endsWith(head))) return undefined;
  const candidates = new Set<string>([normalized, ...words]);
  for (let i = 0; i < words.length; i += 1) {
    candidates.add(`${words[i] ?? ''}${words[i + 1] ?? ''}`);
    candidates.add(`${words[i] ?? ''}${words[i + 1] ?? ''}${words[i + 2] ?? ''}`);
  }
  for (const [compound, category] of SECRET_COMPOUNDS) {
    if (candidates.has(compound) || normalized.endsWith(compound)) return category;
  }
  return undefined;
}

function isOpaquePayload(key: string, owner: Record<string, unknown>): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (normalized.includes('base64') || normalized.endsWith('binary') || normalized.endsWith('bytes')) return true;
  const type = String(owner.type ?? '').toLowerCase();
  return normalized === 'data' && (type === 'image' || type === 'audio' || type === 'blob');
}

function marker(category: SecretCategory): string { return `${REDACTED_PREFIX}${category}]`; }
function isRedactedMarker(value: unknown): boolean {
  return typeof value === 'string'
    && SECRET_CATEGORIES.some((category) => value === marker(category));
}
function isTruncationMarker(value: string): boolean {
  return TRUNCATION_REASONS.some((reason) => value === `${TRUNCATED_PREFIX}${reason}]`);
}

/**
 * Property names are serialized just like values. Scan only the bounded key
 * itself, then replace a sensitive name wholesale so no substring of it can
 * escape in a partially-redacted key. The parent summary absorbs the local
 * categories/counts, but not the local string truncation: overlong keys have a
 * dedicated object-key machine fact below.
 */
function inspectPropertyKey(rawKey: string, state: WalkState): SecretCategory | undefined {
  const boundedKey = rawKey.slice(0, state.options.maxKeyChars);
  const result = redactSecrets(boundedKey, {
    maxDepth: 1,
    maxNodes: 2,
    maxArrayItems: 1,
    maxObjectKeys: 1,
    maxKeyChars: state.options.maxKeyChars,
    maxStringChars: state.options.maxKeyChars,
    maxTotalStringChars: state.options.maxKeyChars,
  });
  if (!result.summary.applied) return undefined;
  for (const category of result.summary.categories) state.categories.add(category);
  state.redactedValues += result.summary.redacted_values;
  return result.summary.categories[0] ?? 'credential';
}

function uniquePropertyPlaceholder(base: string, reserved: Set<string>, emitted: Set<string>): string {
  let candidate = base;
  let suffix = 1;
  while (reserved.has(candidate) || emitted.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function truncated(state: WalkState, reason: TruncationReason): WalkResult<unknown> {
  state.truncationReasons.add(reason);
  return { value: `${TRUNCATED_PREFIX}${reason}]`, changed: true };
}

function summaryOf(state: WalkState): SecretRedactionSummary {
  return {
    applied: state.redactedValues > 0,
    redacted_values: state.redactedValues,
    categories: [...state.categories].sort(),
    truncated: state.truncationReasons.size > 0,
    truncation_reasons: [...state.truncationReasons].sort(),
  };
}

function validateOptions(options: Required<SecretRedactionOptions>): Required<SecretRedactionOptions> {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defineSafe(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function cloneWithProperty(source: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [existingKey, existingValue] of Object.entries(source)) defineSafe(output, existingKey, existingValue);
  defineSafe(output, key, value);
  return output;
}

function attachObjectFact<T>(value: T, key: string, summary: SecretRedactionSummary): T {
  if (Array.isArray(value)) {
    const output = value.slice(0, Math.max(0, DEFAULTS.maxArrayItems - 1));
    output.push({ [key]: summary } as never);
    return output as T;
  }
  if (!isRecord(value) || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  return cloneWithProperty(value, key, summary) as T;
}
