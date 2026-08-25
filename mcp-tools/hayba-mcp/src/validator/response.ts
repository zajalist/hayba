// Wire validator findings into MCP responses.
//
// Two helpers:
//   - attachFindingsToResponse  → wraps an MCP {content,isError} payload
//   - attachFindingsToValue     → wraps a raw JSON value (handler that returns
//                                 plain JSON, then is JSON.stringified for MCP)

import type { FindingRecord } from './history.js';

interface McpResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function findingToLine(f: FindingRecord): string {
  const tag = f.severity === 'error' ? '[validator:error]'
            : f.severity === 'warning' ? '[validator:warning]'
            : '[validator:info]';
  const refs = f.refs && f.refs.length ? ` (${f.refs.join(' ')})` : '';

  // The signed margin, when the check measured one. Always signed: the sign is
  // the direction, and a line saying a rule failed without saying by how much
  // is the red X the IA rules out. `+` for a satisfied margin reads oddly at
  // first and is correct -- an info finding can report headroom.
  const m = f.measurement;
  const margin = m ? ` [${m.value >= 0 ? '+' : ''}${m.value}${m.unit}` +
    `${m.fix ? ', fix available' : ''}]` : '';

  return `${tag} ${f.ruleId}: ${f.message}${margin}${refs} — ${f.hint}`;
}

export function attachFindingsToResponse(
  resp: McpResponse,
  findings: FindingRecord[],
): McpResponse {
  if (!findings.length) return resp;
  const isError = resp.isError === true || findings.some(f => f.severity === 'error');
  const extra = findings.map(findingToLine).join('\n');
  // The whole record, not a hand-picked subset.
  //
  // This used to project seven fields by name and silently dropped
  // `measurement` -- the signed margin and fix vector, which is the one part
  // of a finding the IA calls essential ("the amount, the direction, and an
  // available next action"). It also dropped `subject` and `category`. None of
  // that was a decision: `measurement` was added to Finding later and this
  // list was never revisited, which is what a hand-written projection does.
  //
  // The sibling helper below had the identical bug -- I first assumed it was
  // fine because its return type says FindingRecord[], which is a claim a cast
  // was making rather than a fact the code honoured.
  //
  // `data` is re-exposed as `context` for the shape the Slate panel reads,
  // which accepts both spellings.
  const validatorBlock = {
    findings: findings.map(f => ({ ...f, context: f.data })),
  };
  return {
    ...resp,
    isError,
    content: [
      ...resp.content,
      { type: 'text', text: `\n${extra}` },
      { type: 'text', text: JSON.stringify({ validator: validatorBlock }, null, 2) },
    ],
  };
}

export function attachFindingsToValue<T extends Record<string, unknown>>(
  value: T,
  findings: FindingRecord[],
): T & { validator?: { findings: FindingRecord[] } } {
  if (!findings.length) return value;
  // The record as-is. This used to project the same seven fields as the helper
  // above -- dropping measurement, subject and category -- and then force the
  // result past the compiler with `as unknown as FindingRecord[]`. That cast is
  // why nothing caught it: the type claimed FindingRecord while the runtime
  // object was a subset, and the double assertion silenced the exact error
  // TypeScript would otherwise have raised.
  return {
    ...value,
    validator: {
      findings: findings.map(f => ({ ...f, context: f.data })),
    },
  };
}
