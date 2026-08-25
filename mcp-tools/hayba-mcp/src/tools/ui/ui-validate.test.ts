import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';
import { uiValidateHandler } from './ui-validate.js';
import { setHistoryPath } from '../../validator/history.js';
import { setConfigPath } from '../../validator/config.js';

// Regression tests for the reporting path.
//
// The rules themselves are covered in src/validator/ui/ui-rules.test.ts. What
// is pinned here is that findings actually REACH somewhere the user looks: a
// live editor showed the validator working correctly while the Validation
// panel stayed empty, because nothing routed the findings anywhere.

let tmp: string;
let historyPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hayba-ui-validate-'));
  historyPath = join(tmp, 'validator-history.jsonl');
  setHistoryPath(historyPath);
  setConfigPath(join(tmp, 'validator-config.json'));
});

afterEach(() => {
  setHistoryPath(null);
  setConfigPath(null);
  rmSync(tmp, { recursive: true, force: true });
});

/** A snapshot with one guaranteed finding: text that overflows its box. */
function snapshotWithOverflow() {
  return {
    widget_blueprint_path: '/Game/UI/WBP_Probe',
    screen_width: 1920,
    screen_height: 1080,
    layout_resolved: true,
    widget_count: 1,
    widgets: [
      {
        name: 'NameLabel',
        class: 'TextBlock',
        parent: '',
        slot_class: 'CanvasPanelSlot',
        is_panel: false,
        is_variable: true,
        visibility: 'ESlateVisibility::Visible',
        render_opacity: 1,
        is_enabled: true,
        is_interactive: false,
        is_focusable: false,
        laid_out: true,
        x: 100,
        y: 100,
        width: 200,
        height: 40,
        depth: 0,
        text_info: {
          text: 'Bartholomew Ravensworth III',
          font_size: 24,
          auto_wrap: false,
          measured_width: 421,
          available_width: 200,
          overflows: true,
          chars_that_fit: 12,
        },
      },
    ],
  };
}

function historyLines(): Array<Record<string, unknown>> {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('ui_validate reporting', () => {
  it('pushes findings to the editor panel and writes them to history', async () => {
    let pushed: Record<string, unknown> | null = null;
    const exec = new InMemoryToolExecutor()
      .on('ui_layout_snapshot', () => ({ ok: true, data: snapshotWithOverflow() }))
      .on('ui_report_findings', (p) => {
        pushed = p;
        return { ok: true, data: { received: 1 } };
      });
    setDefaultSender(exec.send);

    const r = await uiValidateHandler({ widget_blueprint_path: '/Game/UI/WBP_Probe' }, undefined as never);
    expect(r.isError).toBeFalsy();

    // Reached the panel.
    expect(pushed).not.toBeNull();
    const findings = (pushed as unknown as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings.some((f) => f.rule_id === 'ui_text_overflows_box')).toBe(true);
    // The hint is the actionable half — it must survive the trip.
    expect(findings[0]!.hint).toBeTruthy();
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.widget).toBe('NameLabel');

    // And reached the history file.
    const lines = historyLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.ruleId === 'ui_text_overflows_box')).toBe(true);
    const context = lines[0]!.data as Record<string, unknown>;
    expect(context.widget_blueprint_path).toBe('/Game/UI/WBP_Probe');
    expect(context.platform).toBe('pc');
  });

  it('gives each finding a distinct history key so they can be resolved individually', async () => {
    const twoFindings = snapshotWithOverflow();
    twoFindings.widgets.push({
      ...twoFindings.widgets[0]!,
      name: 'OtherLabel',
    });
    twoFindings.widget_count = 2;

    const exec = new InMemoryToolExecutor()
      .on('ui_layout_snapshot', () => ({ ok: true, data: twoFindings }))
      .on('ui_report_findings', () => ({ ok: true, data: {} }));
    setDefaultSender(exec.send);

    await uiValidateHandler({ widget_blueprint_path: '/Game/UI/WBP_Probe' }, undefined as never);

    const stamps = historyLines().map((l) => l.timestamp);
    expect(stamps.length).toBe(2);
    expect(new Set(stamps).size).toBe(2);
  });

  it('validates every page when the widget tree exceeds the native response limit', async () => {
    const base = snapshotWithOverflow();
    const second = { ...base.widgets[0]!, name: 'LateObserverAction' };
    const offsets: number[] = [];
    const exec = new InMemoryToolExecutor().on('ui_layout_snapshot', (params) => {
      const offset = Number(params.offset ?? 0);
      offsets.push(offset);
      return {
        ok: true,
        data: {
          ...base,
          widget_count: 1,
          total_widget_count: 2,
          matched_widget_count: 2,
          offset,
          limit: 50,
          has_more: offset === 0,
          next_offset: offset === 0 ? 1 : undefined,
          widgets: offset === 0 ? [base.widgets[0]!] : [second],
        },
      };
    });
    setDefaultSender(exec.send);

    const r = await uiValidateHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Probe', persist: false },
      undefined as never,
    );
    const parsed = JSON.parse(r.content[0]!.text) as {
      findings: Array<{ ruleId: string; subject?: string }>;
    };

    expect(offsets).toEqual([0, 1]);
    expect(parsed.findings.some((f) => f.ruleId === 'ui_text_overflows_box' && f.subject === 'NameLabel')).toBe(true);
    expect(parsed.findings.some((f) => f.ruleId === 'ui_text_overflows_box' && f.subject === 'LateObserverAction')).toBe(true);
  });

  it('fails closed when an older plugin repeats page one instead of honoring pagination', async () => {
    const truncated = {
      ...snapshotWithOverflow(),
      widget_count: 51,
      widgets: snapshotWithOverflow().widgets,
    };
    const exec = new InMemoryToolExecutor().on('ui_layout_snapshot', () => ({ ok: true, data: truncated }));
    setDefaultSender(exec.send);

    await expect(
      uiValidateHandler({ widget_blueprint_path: '/Game/UI/WBP_Probe', persist: false }, undefined as never),
    ).rejects.toThrow('refusing to validate an incomplete widget tree');
  });

  it('still returns findings when the plugin is too old to accept the push', async () => {
    // An older plugin build has no ui_report_findings. Losing the whole run
    // over a failed push would be worse than losing the panel update.
    const exec = new InMemoryToolExecutor()
      .on('ui_layout_snapshot', () => ({ ok: true, data: snapshotWithOverflow() }))
      .on('ui_report_findings', () => ({ ok: false, error: 'Unknown command: ui_report_findings' }));
    setDefaultSender(exec.send);

    const r = await uiValidateHandler({ widget_blueprint_path: '/Game/UI/WBP_Probe' }, undefined as never);

    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain('ui_text_overflows_box');
    // History is still written even though the panel push failed.
    expect(historyLines().length).toBeGreaterThan(0);
  });

  it('persist:false leaves no trace anywhere', async () => {
    let pushed = false;
    const exec = new InMemoryToolExecutor()
      .on('ui_layout_snapshot', () => ({ ok: true, data: snapshotWithOverflow() }))
      .on('ui_report_findings', () => {
        pushed = true;
        return { ok: true, data: {} };
      });
    setDefaultSender(exec.send);

    const r = await uiValidateHandler(
      { widget_blueprint_path: '/Game/UI/WBP_Probe', persist: false },
      undefined as never,
    );

    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain('ui_text_overflows_box');
    expect(pushed).toBe(false);
    expect(historyLines()).toHaveLength(0);
  });

  it('reports skipped geometry rules rather than passing them when layout failed', async () => {
    const noLayout = {
      ...snapshotWithOverflow(),
      layout_resolved: false,
      layout_error: 'widget blueprint has no GeneratedClass — compile it first',
    };
    const exec = new InMemoryToolExecutor()
      .on('ui_layout_snapshot', () => ({ ok: true, data: noLayout }))
      .on('ui_report_findings', () => ({ ok: true, data: {} }));
    setDefaultSender(exec.send);

    const r = await uiValidateHandler({ widget_blueprint_path: '/Game/UI/WBP_Probe' }, undefined as never);
    const parsed = JSON.parse(r.content[0]!.text) as {
      layout_resolved: boolean;
      layout_error?: string;
      rules_skipped_no_layout: string[];
    };

    expect(parsed.layout_resolved).toBe(false);
    expect(parsed.layout_error).toContain('compile it first');
    expect(parsed.rules_skipped_no_layout).toContain('ui_text_overflows_box');
  });
});
