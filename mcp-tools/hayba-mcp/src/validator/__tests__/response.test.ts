import { describe, it, expect } from 'vitest';
import { attachFindingsToResponse, attachFindingsToValue } from '../response.js';
import type { FindingRecord } from '../history.js';

/**
 * response.ts had no tests, which is how it came to drop the signed margin.
 *
 * It hand-projected findings into a smaller object listing seven fields by
 * name. `measurement` was added to Finding later and the list was never
 * revisited, so every agent reading a tool response got "a rule failed" with
 * no amount, no direction and no fix — the red X the IA rules out.
 *
 * The tests that matter here are about what SURVIVES the trip, not about
 * formatting.
 */

function record(over: Partial<FindingRecord> = {}): FindingRecord {
  return {
    ruleId: 'clearance.doorway',
    category: 'spatial',
    severity: 'error',
    message: 'Doorway clearance short.',
    hint: 'Apply the fix vector.',
    subject: 'SM_Crate_03',
    measurement: {
      value: -0.62,
      unit: 'm',
      detail: '0.58m < 1.20m',
      fix: { translate: [0, 0.62, 0] },
    },
    refs: ['SM_Crate_03'],
    data: { actor_label: 'SM_Crate_03' },
    timestamp: '2026-08-25T15:40:02Z',
    toolName: 'actor_spawn',
    ...over,
  } as FindingRecord;
}

function validatorBlock(resp: { content: Array<{ type: 'text'; text: string }> }) {
  // The block is appended as the last text part, JSON-encoded.
  const last = resp.content[resp.content.length - 1]!.text;
  return JSON.parse(last).validator;
}

describe('attachFindingsToResponse', () => {
  const base = { content: [{ type: 'text' as const, text: 'ok' }] };

  it('carries the signed margin through to the agent', () => {
    const block = validatorBlock(attachFindingsToResponse(base, [record()]));
    const f = block.findings[0];
    expect(f.measurement).toBeDefined();
    expect(f.measurement.value).toBe(-0.62);
    expect(f.measurement.unit).toBe('m');
  });

  it('carries the fix vector, so a next action is available', () => {
    const block = validatorBlock(attachFindingsToResponse(base, [record()]));
    expect(block.findings[0].measurement.fix.translate).toEqual([0, 0.62, 0]);
  });

  it('keeps the fields a hand-written projection kept losing', () => {
    const block = validatorBlock(attachFindingsToResponse(base, [record()]));
    const f = block.findings[0];
    // subject and category were dropped alongside measurement. Named here so a
    // future projection cannot quietly shed them again.
    expect(f.subject).toBe('SM_Crate_03');
    expect(f.category).toBe('spatial');
    expect(f.ruleId).toBe('clearance.doorway');
    expect(f.timestamp).toBe('2026-08-25T15:40:02Z');
  });

  it('still exposes data under the context spelling the Slate panel reads', () => {
    const block = validatorBlock(attachFindingsToResponse(base, [record()]));
    expect(block.findings[0].context).toEqual({ actor_label: 'SM_Crate_03' });
  });

  it('puts the margin in the human-readable line, signed', () => {
    const resp = attachFindingsToResponse(base, [record()]);
    const line = resp.content.map(c => c.text).join('\n');
    expect(line).toContain('-0.62m');
    expect(line).toContain('fix available');
  });

  it('says nothing about a margin when the check did not measure one', () => {
    // Absent and zero are different claims. A finding with no measurement must
    // not render as "+0m", which would read as sitting exactly on the limit.
    const resp = attachFindingsToResponse(base, [record({ measurement: undefined })]);
    const line = resp.content.map(c => c.text).join('\n');
    expect(line).not.toContain('[+0');
    expect(line).not.toContain('fix available');
  });

  it('marks the response as an error when any finding is one', () => {
    const resp = attachFindingsToResponse(base, [record()]);
    expect(resp.isError).toBe(true);
  });

  it('leaves a response untouched when there are no findings', () => {
    expect(attachFindingsToResponse(base, [])).toBe(base);
  });
});

describe('attachFindingsToValue', () => {
  it('agrees with the response path about what a finding contains', () => {
    // These two helpers carry the same data by different routes. They drifted
    // once already -- only the hand-projected one lost fields -- so the useful
    // assertion is that they still agree.
    const r = record();
    const viaValue = attachFindingsToValue({ ok: true }, [r]);
    const viaResponse = validatorBlock(
      attachFindingsToResponse({ content: [{ type: 'text', text: 'ok' }] }, [r]),
    );
    expect(viaValue.validator!.findings[0].measurement)
      .toEqual(viaResponse.findings[0].measurement);
  });
});
