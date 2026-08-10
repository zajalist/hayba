import { describe, it, expect } from 'vitest';
import { parseSpec, SpecParseError } from './spec.js';

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
