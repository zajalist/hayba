export type HaybaToolCost = 'low' | 'medium' | 'high';

export interface HaybaToolMeta {
  cost: HaybaToolCost;
  effects: string[];
  when: string;
  not_when: string;
  /**
   * Optional domain pack assignment for tools NOT organized into a subdirectory
   * of src/tools/. Tools in subdirs derive their pack from the directory name.
   * Unset for root-level tools = joins the `core` default pack with a warning.
   */
  pack?: string;
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
