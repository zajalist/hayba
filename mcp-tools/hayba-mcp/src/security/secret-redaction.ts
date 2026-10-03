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
  'accessor' | 'array_items' | 'cycle' | 'depth' | 'nodes' | 'object_keys' | 'opaque_object' | 'serializer' | 'string_chars' | 'symbol_keys' | 'total_string_chars';

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
  'opaque_object',
  'serializer',
  'string_chars',
  'symbol_keys',
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
const CUSTOM_INSPECT = Symbol.for('nodejs.util.inspect.custom');
const JSON_WRAPPED_RESPONSES = new WeakSet<object>();

const MEASUREMENT_HEADS = new Set([
  'age',
  'algorithm',
  'allowed',
  'at',
  'budget',
  'count',
  'date',
  'depth',
  'disabled',
  'duration',
  'enabled',
  'error',
  'expired',
  'format',
  'found',
  'id',
  'index',
  'kind',
  'label',
  'last4',
  'length',
  'limit',
  'max',
  'message',
  'min',
  'missing',
  'mode',
  'name',
  'offset',
  'order',
  'policy',
  'position',
  'present',
  'reason',
  'remaining',
  'required',
  'rule',
  'scheme',
  'size',
  'source',
  'state',
  'status',
  'supported',
  'time',
  'timestamp',
  'total',
  'ttl',
  'type',
  'used',
  'valid',
  'version',
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
const PROVIDER_KEY =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/g;
const URL_SECRET =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|signature|sig|x-amz-signature|x-amz-credential)=)([^&#\s]+)/gi;
const URL_USERINFO = /(\bhttps?:\/\/[^\s\/@:]+:)([^\s\/@]+)(@)/gi;
const ASSIGNMENT =
  /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key|password|passwd|pwd|token|secret|authorization|credential|x-api-key|cookie|set-cookie)["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\\r\n])*)"?|'((?:\\.|[^'\\\r\n])*)'?|([^"'&,;\s}\]]+))/gi;

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
  return cloneWithProperty(
    result.value,
    '_meta',
    cloneWithProperty(currentMeta, SECURITY_META_KEY, result.summary),
  ) as T;
}

/** Preserve Error type while ensuring SDK error serialization and stacks are safe. */
export function redactThrown(error: unknown): unknown {
  try {
    return redactBoundaryValue(error);
  } catch {
    return new Error(`${TRUNCATED_PREFIX}accessor]`);
  }
}

/** Install once at process startup so dynamic stderr arguments cannot bypass policy. */
export function installConsoleSecretRedaction(): void {
  const tagged = console as Console & { [CONSOLE_INSTALLED]?: boolean };
  if (tagged[CONSOLE_INSTALLED]) return;
  for (const level of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = ((...args: unknown[]) => original(...args.map(redactThrown))) as (typeof console)[typeof level];
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
  if (value instanceof Date) {
    try {
      // Use Date's built-in methods, never an instance/prototype toJSON hook.
      const timestamp = Date.prototype.getTime.call(value);
      const iso = Number.isFinite(timestamp) ? Date.prototype.toISOString.call(value) : null;
      return iso === null ? { value: null as T, changed: true } : { ...walkString(iso, state, false), changed: true } as WalkResult<T>;
    } catch {
      return truncated(state, 'opaque_object') as WalkResult<T>;
    }
  }
  if (state.active.has(value)) return truncated(state, 'cycle') as WalkResult<T>;

  state.active.add(value);
  try {
    try {
      if (Array.isArray(value)) return walkArray(value, state, depth) as WalkResult<T>;
      if (value instanceof Error) return walkError(value, state, depth) as WalkResult<T>;
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
  const serializer = hasActiveHook(value, 'toJSON') || hasActiveHook(value, CUSTOM_INSPECT);
  const symbols = Object.getOwnPropertySymbols(value).length > 0;
  let changed = value.length > limit || serializer || symbols;
  if (value.length > limit) state.truncationReasons.add('array_items');
  if (serializer) state.truncationReasons.add('serializer');
  if (symbols) state.truncationReasons.add('symbol_keys');
  const output: unknown[] = [];
  if (serializer) {
    Object.defineProperty(output, 'toJSON', { value: undefined, configurable: true });
    Object.defineProperty(output, CUSTOM_INSPECT, { value: undefined, configurable: true });
  }
  for (let i = 0; i < limit; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) {
      // Array indexing can invoke own or inherited getters, including through
      // a proxy. A hole serializes as null; an accessor is omitted safely.
      output.push(descriptor ? `${TRUNCATED_PREFIX}accessor]` : null);
      if (descriptor) state.truncationReasons.add('accessor');
      changed = true;
    } else {
      const next = walk(descriptor.value, state, depth + 1, false);
      output.push(next.value);
      changed ||= next.changed;
    }
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function walkError(value: Error, state: WalkState, depth: number): WalkResult<Error> {
  if (Object.getOwnPropertySymbols(value).length > 0) state.truncationReasons.add('symbol_keys');
  const readField = (key: 'message' | 'name' | 'stack' | 'cause'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if ('value' in descriptor) return descriptor.value;
    state.truncationReasons.add('accessor');
    return `${TRUNCATED_PREFIX}accessor]`;
  };
  const rawMessage = readField('message');
  const rawName = readField('name');
  const rawStack = readField('stack');
  const rawCause = readField('cause');
  const message = walk(typeof rawMessage === 'string' ? rawMessage : '', state, depth + 1, false).value;
  const name = walk(typeof rawName === 'string' ? rawName : 'Error', state, depth + 1, false).value;
  const stack = walk(typeof rawStack === 'string' ? rawStack : '', state, depth + 1, false).value;
  const cause = rawCause === undefined ? undefined : walk(rawCause, state, depth + 1, false).value;

  const details: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === 'message' || key === 'name' || key === 'stack' || key === 'cause') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) defineSafe(details, key, descriptor.value);
    else {
      defineSafe(details, key, `${TRUNCATED_PREFIX}accessor]`);
      state.truncationReasons.add('accessor');
    }
  }
  const safeDetails = walkObject(details, state, depth + 1).value;
  const safe = new Error(message, cause === undefined ? undefined : { cause });
  safe.name = name;
  if (rawStack !== undefined) safe.stack = stack;
  // A newly created Error can still inherit a process-level toJSON override.
  Object.defineProperty(safe, 'toJSON', { value: undefined, configurable: true });
  Object.defineProperty(safe, CUSTOM_INSPECT, { value: undefined, configurable: true });
  for (const [key, detail] of Object.entries(safeDetails)) defineSafe(safe as unknown as Record<string, unknown>, key, detail);
  return { value: safe, changed: true };
}

function walkObject(
  value: Record<string, unknown>,
  state: WalkState,
  depth: number,
): WalkResult<Record<string, unknown>> {
  // Plain data can be returned by reference when unchanged. Class instances
  // can hide state in native slots that console inspection would print but a
  // property walk cannot examine, so project their own data into a plain value.
  const prototype = Object.getPrototypeOf(value);
  const opaqueObject = prototype !== Object.prototype && prototype !== null;
  if (opaqueObject) state.truncationReasons.add('opaque_object');
  const serializer = hasActiveHook(value, 'toJSON') || hasActiveHook(value, CUSTOM_INSPECT);
  if (serializer) state.truncationReasons.add('serializer');
  const symbols = Object.getOwnPropertySymbols(value).length > 0;
  if (symbols) state.truncationReasons.add('symbol_keys');
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    // JSON.stringify invokes toJSON before visiting any walked properties.
    // Never copy a callable serializer into the safe output.
    if (key === 'toJSON' && serializer) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) entries.push([key, descriptor.value]);
    else {
      entries.push([key, `${TRUNCATED_PREFIX}accessor]`]);
      state.truncationReasons.add('accessor');
    }
  }
  const limit = Math.min(entries.length, state.options.maxObjectKeys);
  let changed = entries.length > limit || serializer || opaqueObject || symbols;
  if (entries.length > limit) state.truncationReasons.add('object_keys');
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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

function hasActiveHook(value: object, key: string | symbol): boolean {
  let owner: object | null = value;
  for (let depth = 0; depth < 32 && owner !== null; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function';
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  // A hostile prototype chain that cannot be checked in a bounded walk must
  // never be trusted to serialize the original object.
  return owner !== null;
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
  return (
    normalized === 'error' ||
    normalized === 'errors' ||
    normalized === 'mandatoryrecovery' ||
    normalized === 'recovery' ||
    normalized === 'recoveryaction' ||
    normalized === 'recoveryactions'
  );
}

function walkString(value: string, state: WalkState, opaque: boolean): WalkResult<string> {
  if (isRedactedMarker(value) || isTruncationMarker(value)) return { value, changed: false };
  // Binary/base64 payloads retain exact bytes; transport response limits remain
  // their allocation boundary. A trusted-looking key is not proof of encoding:
  // malformed prose must still be scanned, and an AWS access-key id is itself
  // valid base64 syntax. Secret-named keys are masked before this point.
  if (opaque && isStructurallyValidBase64(value) && !isHighConfidenceProviderKey(value)) {
    return { value, changed: false };
  }

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
  ({ text, changed } = replaceAssignment(text, changed, state));
  return changed ? { value: text, changed: true } : { value, changed: false };
}

function isStructurallyValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let firstPadding = -1;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x3d) {
      // =
      if (firstPadding < 0) firstPadding = i;
      continue;
    }
    const asciiAlphabet =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (firstPadding >= 0 || !asciiAlphabet) return false;
  }
  if (firstPadding >= 0) {
    const padding = value.length - firstPadding;
    if (padding < 1 || padding > 2) return false;
  }
  return true;
}

function isHighConfidenceProviderKey(value: string): boolean {
  if (value.length !== 20 || !value.startsWith('AKIA')) return false;
  for (let i = 4; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (!((code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39))) return false;
  }
  return true;
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

function replaceAssignment(input: string, changed: boolean, state: WalkState): { text: string; changed: boolean } {
  const text = input.replace(ASSIGNMENT, (match, prefix: string, doubleQuoted: string | undefined,
    singleQuoted: string | undefined, bare: string | undefined) => {
    const raw = doubleQuoted ?? singleQuoted ?? bare ?? '';
    // The bare value regex stops before `]`, whereas quoted values include it.
    if (isRedactedMarker(raw) || (bare !== undefined && isRedactedMarker(`${raw}]`))) return match;
    state.categories.add('credential');
    state.redactedValues += 1;
    const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
    return `${prefix}${quote}${marker('credential')}${quote}`;
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
    if (begin < 0) {
      output += input.slice(cursor);
      break;
    }
    const headerEnd = input.indexOf(terminal, begin);
    if (headerEnd < 0 || headerEnd - begin > 80) {
      output += input.slice(cursor, begin + 11);
      cursor = begin + 11;
      continue;
    }
    const end = input.indexOf(terminal, headerEnd + terminal.length);
    if (end < 0) {
      output += input.slice(cursor, begin);
      output += marker('private_key');
      cursor = input.length;
    } else {
      output += input.slice(cursor, begin);
      output += marker('private_key');
      cursor = end + terminal.length;
    }
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

function marker(category: SecretCategory): string {
  return `${REDACTED_PREFIX}${category}]`;
}
function isRedactedMarker(value: unknown): boolean {
  return typeof value === 'string' && SECRET_CATEGORIES.some((category) => value === marker(category));
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
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
  if (value instanceof Error) {
    // walkError always creates a fresh Error, so annotating it cannot mutate
    // the handler-owned exception or discard its non-enumerable diagnostics.
    defineSafe(value as Record<string, unknown>, key, summary);
    return value;
  }
  return cloneWithProperty(value, key, summary) as T;
}
