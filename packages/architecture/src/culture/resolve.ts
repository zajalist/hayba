import type { Culture, Rule } from '../schema-v2.js';

export function resolveRules(
  culture: Culture,
  eraId: string,
  scenario: string,
  tagState: Record<string, string>
): Rule['assigns'] {
  const era = culture.eras.find(e => e.id === eraId);
  if (!era) return {};
  const eraIds = new Set(era.rules.map(r => r.id));
  const sourced: { rule: Rule; source: 0 | 1 }[] = [
    ...culture.rules.filter(r => !eraIds.has(r.id)).map(rule => ({ rule, source: 0 as const })),
    ...era.rules.map(rule => ({ rule, source: 1 as const })),
  ];
  const matches = sourced.filter(({ rule }) => {
    if (rule.conditions.scenario !== undefined && rule.conditions.scenario !== scenario) return false;
    for (const [axis, val] of Object.entries(rule.conditions.tagMatches)) {
      if (tagState[axis] !== val) return false;
    }
    return true;
  });
  matches.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
    return a.source - b.source; // 0 (culture) before 1 (era)
  });
  return matches[0]?.rule.assigns ?? {};
}
