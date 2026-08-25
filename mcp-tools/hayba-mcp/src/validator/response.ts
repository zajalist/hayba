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
  return `${tag} ${f.ruleId}: ${f.message}${refs} — ${f.hint}`;
}

export function attachFindingsToResponse(
  resp: McpResponse,
  findings: FindingRecord[],
): McpResponse {
  if (!findings.length) return resp;
  const isError = resp.isError === true || findings.some(f => f.severity === 'error');
  const extra = findings.map(findingToLine).join('\n');
  const validatorBlock = {
    findings: findings.map(f => ({
      ruleId: f.ruleId,
      severity: f.severity,
      message: f.message,
      hint: f.hint,
      refs: f.refs,
      context: f.data,
      timestamp: f.timestamp,
    })),
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
  return {
    ...value,
    validator: {
      findings: findings.map(f => ({
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
        hint: f.hint,
        refs: f.refs,
        context: f.data,
        timestamp: f.timestamp,
      })) as unknown as FindingRecord[],
    },
  };
}
