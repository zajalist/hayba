import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { CLI_SPEC_MAX_INPUT_BYTES, parseSpec, SpecParseError } from './spec.js';

describe('parseSpec', () => {
  it('parses a valid JSON spec', () => {
    const spec = parseSpec(
      JSON.stringify({ steps: [{ cmd: 'ping' }, { cmd: 'actor_spawn', params: { class: 'Foo' }, name: 'spawn foo' }] }),
      'spec.json',
    );
    expect(spec.version).toBe(1);
    expect(spec.steps).toEqual([
      { cmd: 'ping', params: {}, name: undefined },
      { cmd: 'actor_spawn', params: { class: 'Foo' }, name: 'spawn foo' },
    ]);
  });

  it('parses a valid YAML spec by .yaml extension', () => {
    const yaml = ['steps:', '  - cmd: ping', '  - cmd: actor_spawn', '    params:', '      class: Foo'].join('\n');
    const spec = parseSpec(yaml, 'spec.yaml');
    expect(spec.steps).toHaveLength(2);
    expect(spec.steps[1].cmd).toBe('actor_spawn');
    expect(spec.steps[1].params).toEqual({ class: 'Foo' });
  });

  it('falls back from JSON to YAML when no filename hint is given (e.g. stdin)', () => {
    const yaml = 'steps:\n  - cmd: ping\n';
    const spec = parseSpec(yaml);
    expect(spec.steps).toEqual([{ cmd: 'ping', params: {}, name: undefined }]);
  });

  it('parses the checked-in CLI example without changing its command shape', () => {
    const raw = readFileSync(new URL('../../examples/sample-spec.yaml', import.meta.url), 'utf8');
    expect(parseSpec(raw, 'sample-spec.yaml')).toEqual({
      version: 1,
      steps: [
        {
          cmd: 'ping',
          name: 'sanity check the connection before doing real work',
          params: {},
        },
      ],
    });
  });

  it('uses YAML 1.2 CORE scalar semantics in params', () => {
    const yaml = [
      'steps:',
      '  - cmd: ping',
      '    params:',
      '      legacy_yes: yes',
      '      legacy_on: on',
      '      leading_zero: 012',
      '      date: 2026-08-10',
      '      real_bool: true',
    ].join('\n');
    expect(parseSpec(yaml, 'spec.yaml').steps[0].params).toEqual({
      legacy_yes: 'yes',
      legacy_on: 'on',
      leading_zero: 12,
      date: '2026-08-10',
      real_bool: true,
    });
  });

  it('rejects empty YAML with a stable diagnostic', () => {
    expect(() => parseSpec('', 'spec.yaml')).toThrow('could not parse spec as JSON or YAML: CLI spec is empty');
  });

  it('bounds JSON and YAML specs before either parser runs', () => {
    const oversized = `{"steps":[{"cmd":"${'a'.repeat(CLI_SPEC_MAX_INPUT_BYTES)}"}]}`;
    expect(() => parseSpec(oversized, 'spec.json')).toThrow(
      `spec exceeds the ${CLI_SPEC_MAX_INPUT_BYTES}-byte input limit`,
    );
    expect(() => parseSpec(oversized, 'spec.yaml')).toThrow(
      `spec exceeds the ${CLI_SPEC_MAX_INPUT_BYTES}-byte input limit`,
    );
  });

  it('never includes malformed YAML source or credentials in its diagnostic', () => {
    const secret = 'sk-live-NEVER-ECHO';
    let error: unknown;
    try {
      parseSpec(`steps:\n  - cmd: ping\nsecret: ${secret}\nbroken: [`, 'spec.yaml');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpecParseError);
    expect((error as Error).message).toMatch(/^could not parse spec as JSON or YAML: CLI spec is invalid YAML/);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('broken');
  });

  it('rejects syntactically broken input as neither JSON nor YAML', () => {
    // Tab characters are illegal for YAML indentation and this isn't valid
    // JSON either — guaranteed to fail both parsers.
    const broken = '{ steps: [\n\t"cmd": ';
    expect(() => parseSpec(broken, 'spec.json')).toThrow(SpecParseError);
    expect(() => parseSpec(broken, 'spec.json')).toThrow(/could not parse spec/);
  });

  it('rejects a spec that is not an object', () => {
    expect(() => parseSpec('[1,2,3]', 'spec.json')).toThrow(/must be an object/);
    expect(() => parseSpec('"just a string"', 'spec.json')).toThrow(/must be an object/);
  });

  it('rejects a spec missing steps', () => {
    expect(() => parseSpec('{}', 'spec.json')).toThrow(/spec.steps must be an array/);
  });

  it('rejects a spec with an empty steps array', () => {
    expect(() => parseSpec('{"steps": []}', 'spec.json')).toThrow(/at least one step/);
  });

  it('rejects a step with no cmd', () => {
    expect(() => parseSpec('{"steps": [{"params": {}}]}', 'spec.json')).toThrow(/step\[0\].*"cmd"/);
  });

  it('rejects a step with an empty-string cmd', () => {
    expect(() => parseSpec('{"steps": [{"cmd": "   "}]}', 'spec.json')).toThrow(/step\[0\].*"cmd"/);
  });

  it('rejects a step whose params is not an object', () => {
    expect(() => parseSpec('{"steps": [{"cmd": "ping", "params": "nope"}]}', 'spec.json')).toThrow(
      /step\[0\]\.params must be an object/,
    );
  });

  it('rejects a step that is itself not an object', () => {
    expect(() => parseSpec('{"steps": ["ping"]}', 'spec.json')).toThrow(/step\[0\] must be an object/);
  });

  it('reports the correct index for a later broken step', () => {
    expect(() => parseSpec('{"steps": [{"cmd": "ping"}, {"cmd": ""}]}', 'spec.json')).toThrow(/step\[1\]/);
  });
});
