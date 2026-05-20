import type { HaybaToolMeta } from './hayba-tool-meta.js';

const REGISTRY = new Map<string, HaybaToolMeta>();

export function registerToolMeta(name: string, meta: HaybaToolMeta): void {
  REGISTRY.set(name, meta);
}

export function getToolMeta(name: string): HaybaToolMeta | undefined {
  return REGISTRY.get(name);
}

/** Test-only — clears the registry between specs. */
export function resetToolMetaRegistry(): void {
  REGISTRY.clear();
}
