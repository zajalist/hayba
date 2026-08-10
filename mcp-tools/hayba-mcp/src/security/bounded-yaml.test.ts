import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BoundedYamlError,
  HAYBA_YAML_MAX_ALIASES,
  HAYBA_YAML_MAX_DEPTH,
  HAYBA_YAML_MAX_TOTAL_MERGE_KEYS,
  parseBoundedYaml,
} from './bounded-yaml.js';

const OPTIONS = { label: 'test manifest', maxBytes: 1024 } as const;

describe('bounded YAML 1.2 policy', () => {
  it('uses a named ESM import because js-yaml 5 deliberately has no default export', () => {
    const source = readFileSync(new URL('./bounded-yaml.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/import\s*{[^}]*load as loadYaml[^}]*}\s*from 'js-yaml'/s);
    expect(source).not.toMatch(/import\s+[A-Za-z_$][\w$]*\s+from ['"]js-yaml['"]/);
  });

  it('pins the deliberate resource limits', () => {
    expect(HAYBA_YAML_MAX_DEPTH).toBe(32);
    expect(HAYBA_YAML_MAX_ALIASES).toBe(0);
    expect(HAYBA_YAML_MAX_TOTAL_MERGE_KEYS).toBe(0);
  });

  it('uses CORE_SCHEMA scalar semantics instead of YAML 1.1 coercions', () => {
    expect(
      parseBoundedYaml(
        [
          'legacy_yes: yes',
          'legacy_on: ON',
          'leading_zero: 012',
          'explicit_octal: 0o12',
          'date: 2026-08-10',
          'real_bool: true',
        ].join('\n'),
        OPTIONS,
      ),
    ).toEqual({
      legacy_yes: 'yes',
      legacy_on: 'ON',
      leading_zero: 12,
      explicit_octal: 10,
      date: '2026-08-10',
      real_bool: true,
    });
  });

  it('rejects empty input explicitly', () => {
    expect(() => parseBoundedYaml('', OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'empty_input', message: 'test manifest is empty' }),
    );
  });

  it('bounds UTF-8 bytes rather than JavaScript character count', () => {
    expect(() => parseBoundedYaml('value: éé', { label: 'test manifest', maxBytes: 10 })).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'input_too_large' }),
    );
  });

  it('returns coordinates but never echoes malformed source or secrets', () => {
    const secret = 'github_pat_NEVER_ECHO_THIS';
    let error: unknown;
    try {
      parseBoundedYaml(`token: ${secret}\nbroken: [`, OPTIONS);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BoundedYamlError);
    expect((error as Error).message).toMatch(/^test manifest is invalid YAML at line \d+, column \d+$/);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('broken');
  });

  it('rejects duplicate mapping keys', () => {
    expect(() => parseBoundedYaml('same: 1\nsame: 2\n', OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'invalid_yaml' }),
    );
  });

  it('keeps prototype-shaped keys as inert own data properties', () => {
    const parsed = parseBoundedYaml('__proto__:\n  polluted: value\nconstructor: inert\n', OPTIONS) as Record<
      string,
      unknown
    >;
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toEqual({ polluted: 'value' });
    expect(parsed.constructor).toBe('inert');
  });

  it('rejects complex mapping keys instead of lossy stringification', () => {
    expect(() => parseBoundedYaml('? [one, two]\n: value\n', OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'invalid_yaml' }),
    );
  });

  it('rejects aliases instead of expanding attacker-controlled graphs', () => {
    const aliased = ['base: &base', '  value: 1', 'copy: *base'].join('\n');
    expect(() => parseBoundedYaml(aliased, OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'invalid_yaml' }),
    );
  });

  it('rejects merge keys even though CORE_SCHEMA treats them as ordinary strings', () => {
    const merged = ['defaults:', '  value: 1', 'actual:', '  <<:', '    value: 2'].join('\n');
    expect(() => parseBoundedYaml(merged, OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'merge_key_not_supported' }),
    );
  });

  it('rejects nested flow collections beyond the configured depth', () => {
    const depth = HAYBA_YAML_MAX_DEPTH + 2;
    const nested = `value: ${'['.repeat(depth)}0${']'.repeat(depth)}`;
    expect(() => parseBoundedYaml(nested, OPTIONS)).toThrowError(
      expect.objectContaining<Partial<BoundedYamlError>>({ code: 'invalid_yaml' }),
    );
  });
});
