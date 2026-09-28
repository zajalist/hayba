// Spec text and the Hayba type grammar, ported from the first consumer project's bpgraph.mjs
// (2026-09-27) so a spec
// can be checked with no editor running.

export interface ParsedSpecText {
  value: unknown;
  /** One message per repeated object key; JSON.parse would silently keep the last. */
  duplicates: string[];
}

/**
 * Parse JSON with // and /* *\/ comments and report duplicate object keys.
 * Throws SyntaxError naming the line and column.
 */
export function parseSpecText(text: string): ParsedSpecText {
  let i = 0;
  const duplicates: string[] = [];

  const where = (): string => {
    const before = text.slice(0, i).split('\n');
    return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
  };
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at ${where()}`);
  };

  function skipSpace(): void {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated /* comment');
        i = end + 2;
      } else return;
    }
  }

  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  function parseString(): string {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) throw fail('bad string');
    i = STRING.lastIndex;
    return JSON.parse(m[0]);
  }

  function parseValue(path: string): unknown {
    skipSpace();
    const c = text[i];
    if (c === '{') return parseObject(path);
    if (c === '[') return parseArray(path);
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) throw fail('bad number');
      i = NUMBER.lastIndex;
      return Number(m[0]);
    }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return fail(i >= text.length ? 'unexpected end of input' : `unexpected ${JSON.stringify(c)}`);
  }

  function parseObject(path: string): Record<string, unknown> {
    i++; // {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipSpace();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      skipSpace();
      if (text[i] !== '"') fail('expected a property name in double quotes');
      const key = parseString();
      if (seen.has(key)) duplicates.push(`${path || '(root)'}: duplicate key "${key}"`);
      seen.add(key);
      skipSpace();
      if (text[i] !== ':') fail("expected ':'");
      i++;
      const v = parseValue(path ? `${path}.${key}` : key);
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      skipSpace();
      if (text[i] === ',') {
        i++;
        skipSpace();
        if (text[i] === '}') fail('trailing comma');
        continue;
      }
      if (text[i] === '}') {
        i++;
        return out;
      }
      fail("expected ',' or '}'");
    }
  }

  function parseArray(path: string): unknown[] {
    i++; // [
    const out: unknown[] = [];
    skipSpace();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue(`${path}[${out.length}]`));
      skipSpace();
      if (text[i] === ',') {
        i++;
        skipSpace();
        if (text[i] === ']') fail('trailing comma');
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      fail("expected ',' or ']'");
    }
  }

  const value = parseValue('');
  skipSpace();
  if (i < text.length) fail('unexpected text after the JSON value');
  return { value, duplicates };
}

// ─── Hayba type grammar (mirror of HaybaBlueprintOps::ParseTypeSpec) ─────────

export type TypeKind =
  | 'bool' | 'int' | 'int64' | 'real' | 'string' | 'name' | 'text' | 'byte'
  | 'enum' | 'struct' | 'object' | 'class' | 'soft_object' | 'soft_class';

export type ParsedType = { kind: TypeKind; path: string; array: boolean } | { error: string };

const SCALAR_TYPES = new Map<string, TypeKind>([
  ['bool', 'bool'], ['boolean', 'bool'],
  ['int', 'int'], ['integer', 'int'], ['int32', 'int'],
  ['int64', 'int64'],
  ['float', 'real'], ['double', 'real'], ['real', 'real'],
  ['string', 'string'], ['fstring', 'string'],
  ['name', 'name'], ['fname', 'name'],
  ['text', 'text'], ['ftext', 'text'],
  ['byte', 'byte'], ['uint8', 'byte'],
]);
const ENGINE_STRUCTS = new Map<string, string>([
  ['vector', '/Script/CoreUObject.Vector'],
  ['rotator', '/Script/CoreUObject.Rotator'],
  ['transform', '/Script/CoreUObject.Transform'],
  ['linear_color', '/Script/CoreUObject.LinearColor'],
  ['linearcolor', '/Script/CoreUObject.LinearColor'],
  ['vector2d', '/Script/CoreUObject.Vector2D'],
]);
const REFERENCE_KINDS = new Set<TypeKind>(['object', 'class', 'soft_object', 'soft_class', 'struct', 'enum']);

/** The pin category Hayba's blueprint_get_info reports for a parsed type. */
export const CATEGORY_OF_KIND: Readonly<Record<TypeKind, string>> = {
  bool: 'bool', int: 'int', int64: 'int64', real: 'real', string: 'string', name: 'name', text: 'text',
  byte: 'byte', enum: 'byte', struct: 'struct', object: 'object', class: 'class',
  soft_object: 'softobject', soft_class: 'softclass',
};

/**
 * Parse a Hayba type string (mirror of HaybaBlueprintOps::ParseTypeSpec).
 * Stricter in one way: an object/class reference into /Game must name the
 * generated class (…_C), because the plugin's LoadClass of the asset path fails
 * live with a less direct message.
 */
export function parseType(spec: unknown): ParsedType {
  if (typeof spec !== 'string') return { error: 'type must be a string' };
  const s = spec.trim();
  if (!s) return { error: 'empty type' };
  if (/^array</i.test(s)) {
    if (!s.endsWith('>')) return { error: `'${spec}' opens array< but never closes it` };
    const inner = s.slice(6, -1).trim();
    if (/^array</i.test(inner)) return { error: `'${spec}': arrays of arrays are not a Blueprint type` };
    const t = parseType(inner);
    return 'error' in t ? t : { ...t, array: true };
  }
  const colon = s.indexOf(':');
  if (colon >= 0) {
    const prefix = s.slice(0, colon).trim().toLowerCase() as TypeKind;
    const path = s.slice(colon + 1).trim();
    if (!REFERENCE_KINDS.has(prefix)) return { error: `'${spec}': unknown reference kind '${prefix}'` };
    if (!path.startsWith('/')) return { error: `'${spec}' needs a full path after '${prefix}:'` };
    if (['object', 'class', 'soft_object', 'soft_class'].includes(prefix) && path.startsWith('/Game/') && !/\.[A-Za-z_]\w*_C$/.test(path)) {
      return { error: `'${spec}': a Blueprint class path ends in .Name_C, e.g. /Game/Dir/BP_X.BP_X_C` };
    }
    return { kind: prefix, path, array: false };
  }
  const lower = s.toLowerCase();
  const scalar = SCALAR_TYPES.get(lower);
  if (scalar) return { kind: scalar, path: '', array: false };
  const struct = ENGINE_STRUCTS.get(lower);
  if (struct) return { kind: 'struct', path: struct, array: false };
  return {
    error: `unknown type '${spec}' (accepted: bool, int, int64, float, double, string, name, text, byte, vector, rotator, transform, linear_color, vector2d, object:/class:/soft_object:/soft_class:/struct:/enum:<path>, array<...>)`,
  };
}
