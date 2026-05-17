import {
  validateTypology,
  ArchitectureSchemaError, type ValidationError,
} from './validate.js';
import type { Typology } from './schema.js';

import typologiesFile from './data/typologies.json' with { type: 'json' };

export class ArchitectureRegistryError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`@hayba/architecture: registry load failed (${errors.length} error(s))`);
    this.name = 'ArchitectureRegistryError';
  }
}

export interface Registry {
  readonly typologies: ReadonlyMap<string, Typology>;
  readonly typologyIds: ReadonlySet<string>;
}

let CACHED: Registry | null = null;

export function buildRegistry(
  rawTypos: unknown[],
): Registry {
  const errors: ValidationError[] = [];
  const typologies = new Map<string, Typology>();
  const typologyIds = new Set<string>();

  rawTypos.forEach((t, i) => {
    const errs = validateTypology(t, `/typologies/${i}`);
    if (errs.length === 0) {
      const typed = t as Typology;
      if (typologies.has(typed.id)) {
        errors.push({ path: `/typologies/${i}/id`, message: `duplicate typology id ${JSON.stringify(typed.id)}` });
      } else {
        typologies.set(typed.id, typed);
        typologyIds.add(typed.id);
      }
    } else {
      errors.push(...errs);
    }
  });

  if (errors.length > 0) {
    throw new ArchitectureRegistryError(errors);
  }

  return { typologies, typologyIds };
}

export function loadRegistry(): Registry {
  if (CACHED) return CACHED;

  const rawTypos = (typologiesFile as { typologies?: unknown[] }).typologies;
  if (!Array.isArray(rawTypos)) {
    throw new ArchitectureRegistryError([
      { path: '/typologies', message: 'typologies.json missing "typologies" array' },
    ]);
  }

  CACHED = buildRegistry(rawTypos);
  return CACHED;
}

/** Test-only: drop the cache. NOT exposed via package index. */
export function _resetRegistryCacheForTests(): void {
  CACHED = null;
}

export function getTypology(id: string): Typology | null {
  return loadRegistry().typologies.get(id) ?? null;
}

export { ArchitectureSchemaError };
