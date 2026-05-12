export type HaybaToolCost = 'low' | 'medium' | 'high';

export interface HaybaToolMeta {
  cost: HaybaToolCost;
  effects: string[];
  when: string;
  not_when: string;
}

export function describeMeta(m: HaybaToolMeta): string {
  return [
    `[cost=${m.cost}]`,
    `[effects=[${m.effects.join(',')}]]`,
    `USE_WHEN: ${m.when}`,
    `NOT_WHEN: ${m.not_when}`,
  ].join(' ');
}

export function appendMeta(description: string, meta: HaybaToolMeta): string {
  return `${description}\n\n${describeMeta(meta)}`;
}
