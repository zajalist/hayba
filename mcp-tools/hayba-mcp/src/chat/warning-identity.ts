import { createHash } from 'node:crypto';

/** A stable, opaque identity for one validator finding in one result set. */
export function warningIdForFinding(value: Record<string, unknown>, ordinal: number): string | null {
  const rule = value.ruleId ?? value.rule_id ?? value.id;
  if (typeof rule !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(rule)) return null;
  const identity = [rule, value.timestamp, value.context, value.widget, value.message, ordinal];
  const suffix = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
  return `${rule.slice(0, 63)}_${suffix}`;
}
