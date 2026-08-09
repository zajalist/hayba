import { describe, expect, it } from 'vitest';
import { resolveAliases, type AliasMap } from './param-aliases.js';

describe('resolveAliases', () => {
  const aliases: AliasMap = {
    path: ['widget_blueprint_path'],
    name: ['child_name', 'widget_name'],
  };

  it('passes canonical-only args through untouched', () => {
    const res = resolveAliases({ path: '/Game/A', other: 1 }, aliases);
    expect(res).toEqual({ ok: true, args: { path: '/Game/A', other: 1 } });
  });

  it('copies an alternate value onto the canonical key and drops the alternate', () => {
    const res = resolveAliases({ widget_blueprint_path: '/Game/A' }, aliases);
    expect(res).toEqual({ ok: true, args: { path: '/Game/A' } });
  });

  it('leaves args untouched when neither canonical nor alternate is present', () => {
    const res = resolveAliases({ other: 1 }, aliases);
    expect(res).toEqual({ ok: true, args: { other: 1 } });
  });

  it('resolves whichever of several alternates for one canonical is supplied', () => {
    expect(resolveAliases({ child_name: 'Btn' }, aliases)).toEqual({ ok: true, args: { name: 'Btn' } });
    expect(resolveAliases({ widget_name: 'Btn' }, aliases)).toEqual({ ok: true, args: { name: 'Btn' } });
  });

  it('silently collapses canonical + alternate when the values agree', () => {
    const res = resolveAliases({ path: '/Game/A', widget_blueprint_path: '/Game/A' }, aliases);
    expect(res).toEqual({ ok: true, args: { path: '/Game/A' } });
  });

  it('fails loudly when canonical + alternate disagree — never silently picks one', () => {
    const res = resolveAliases({ path: '/Game/A', widget_blueprint_path: '/Game/B' }, aliases);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('path');
      expect(res.error).toContain('widget_blueprint_path');
    }
  });

  it('fails loudly when two alternates for the same canonical disagree', () => {
    const res = resolveAliases({ child_name: 'A', widget_name: 'B' }, aliases);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('name');
    }
  });

  it('does not mutate the input object', () => {
    const input = { widget_blueprint_path: '/Game/A' };
    resolveAliases(input, aliases);
    expect(input).toEqual({ widget_blueprint_path: '/Game/A' });
  });

  it('is a no-op given an empty alias map', () => {
    const res = resolveAliases({ anything: 1 }, {});
    expect(res).toEqual({ ok: true, args: { anything: 1 } });
  });
});
