import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyAdvisoryVerbosity } from './advisory-verbosity.js';
import { __resetDisabledToolsCache, getAdvisoryVerbosity } from './disabled-tools-watcher.js';
import { VALIDATION_NUDGE } from './hayba-tool-meta.js';
import { UNVERIFIED_MUTATION_WARNING } from './response-evidence.js';
import type { RichToolResult } from './types.js';

const originalPath = process.env.HAYBA_DISABLED_TOOLS_PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.HAYBA_DISABLED_TOOLS_PATH;
  else process.env.HAYBA_DISABLED_TOOLS_PATH = originalPath;
  __resetDisabledToolsCache();
});

function textResult(value: unknown): RichToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

describe('advisory verbosity mirror', () => {
  it('reads the plugin choice and falls back safely on an unknown value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hayba-advisory-'));
    const file = join(dir, 'runtime.json');
    try {
      process.env.HAYBA_DISABLED_TOOLS_PATH = file;
      writeFileSync(file, JSON.stringify({ disabled: [], advisory_verbosity: 'errors_only' }));
      __resetDisabledToolsCache();
      expect(getAdvisoryVerbosity()).toBe('errors_only');

      writeFileSync(file, JSON.stringify({ disabled: [], advisory_verbosity: 'invented' }));
      __resetDisabledToolsCache();
      expect(getAdvisoryVerbosity()).toBe('errors_and_warnings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Node result-boundary advisory filtering', () => {
  it('ErrorsOnly recursively strips warning/tip prose but keeps errors and machine facts', () => {
    const result = textResult({
      ok: false,
      error: 'save failed',
      warnings: ['optional warning'],
      tip: 'optional coaching',
      warning_count: 1,
      failed: 1,
      mandatory_recovery: ['save before exit'],
      nested: { compile_warnings: ['w'], error_detail: 'must survive', hint: 'retry' },
    });
    const filtered = applyAdvisoryVerbosity(result, 'errors_only');
    const payload = JSON.parse((filtered.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('warnings');
    expect(payload).not.toHaveProperty('tip');
    expect(payload).toMatchObject({ error: 'save failed', warning_count: 1, failed: 1 });
    expect(payload.nested).toEqual({ error_detail: 'must survive' });
    expect(payload).toHaveProperty('mandatory_recovery');
  });

  it('warning mode keeps warnings and removes tips', () => {
    const result = textResult({ warnings: ['w'], tips: ['t'], error: 'e' });
    const filtered = applyAdvisoryVerbosity(result, 'errors_and_warnings');
    expect(JSON.parse((filtered.content[0] as { text: string }).text)).toEqual({
      warnings: ['w'],
      error: 'e',
    });
  });

  it('removes centrally-added optional blocks at the requested levels', () => {
    const result: RichToolResult = {
      content: [
        { type: 'text', text: '{"ok":true}' },
        { type: 'text', text: UNVERIFIED_MUTATION_WARNING },
        { type: 'text', text: VALIDATION_NUDGE },
      ],
    };
    expect(applyAdvisoryVerbosity(result, 'errors_only').content).toHaveLength(1);
    expect(
      applyAdvisoryVerbosity(result, 'errors_and_warnings').content.map((b) => (b.type === 'text' ? b.text : '')),
    ).toEqual(['{"ok":true}', UNVERIFIED_MUTATION_WARNING]);
    expect(applyAdvisoryVerbosity(result, 'errors_warnings_and_tips')).toBe(result);
  });

  it('filters validator prose and structured findings by severity without hiding errors', () => {
    const result: RichToolResult = {
      content: [
        {
          type: 'text',
          text: '[validator:error] fatal: bad — fix\n[validator:warning] risk: maybe — inspect\n[validator:info] coach: next — try',
        },
        {
          type: 'text',
          text: JSON.stringify({
            validator: {
              findings: [
                { severity: 'error', message: 'bad', hint: 'fix it' },
                { severity: 'warning', message: 'risk', hint: 'inspect it' },
                { severity: 'info', message: 'coach', hint: 'try it' },
              ],
            },
          }),
        },
      ],
      isError: true,
    };
    const errors = applyAdvisoryVerbosity(result, 'errors_only');
    expect((errors.content[0] as { text: string }).text).toContain('[validator:error]');
    expect((errors.content[0] as { text: string }).text).not.toContain('[validator:warning]');
    const structured = JSON.parse((errors.content[1] as { text: string }).text) as {
      validator: { findings: Array<Record<string, unknown>> };
    };
    expect(structured.validator.findings).toEqual([{ severity: 'error', message: 'bad' }]);
    expect(errors.isError).toBe(true);
  });

  it('never alters image blocks', () => {
    const result: RichToolResult = { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] };
    expect(applyAdvisoryVerbosity(result, 'errors_only')).toBe(result);
  });
});
