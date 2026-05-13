import {
  validateTypology, validateStyleGuide, validateStyleGuideRefs,
  ArchitectureSchemaError, type ValidationError,
} from './validate.js';
import type { StyleGuide, Typology } from './schema.js';

import typologiesFile from './data/typologies.json' with { type: 'json' };

import g01 from './data/style-guides/medieval-european-carolingian.json' with { type: 'json' };
import g02 from './data/style-guides/medieval-european-romanesque.json' with { type: 'json' };
import g03 from './data/style-guides/medieval-european-gothic.json' with { type: 'json' };
import g04 from './data/style-guides/tang-chinese-7c.json' with { type: 'json' };
import g05 from './data/style-guides/tang-chinese-9c.json' with { type: 'json' };
import g06 from './data/style-guides/andean-inca.json' with { type: 'json' };
import g07 from './data/style-guides/andean-pre-inca.json' with { type: 'json' };
import g08 from './data/style-guides/hausa-classical.json' with { type: 'json' };
import g09 from './data/style-guides/edo-japanese-early.json' with { type: 'json' };
import g10 from './data/style-guides/edo-japanese-late.json' with { type: 'json' };
import g11 from './data/style-guides/industrial-revolution-english.json' with { type: 'json' };

const RAW_GUIDES: unknown[] = [g01, g02, g03, g04, g05, g06, g07, g08, g09, g10, g11];

export class ArchitectureRegistryError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`@hayba/architecture: registry load failed (${errors.length} error(s))`);
    this.name = 'ArchitectureRegistryError';
  }
}

export interface Registry {
  readonly typologies: ReadonlyMap<string, Typology>;
  readonly typologyIds: ReadonlySet<string>;
  readonly styleGuidesById: ReadonlyMap<string, StyleGuide>;
  readonly styleGuideOrder: readonly string[];
}

let CACHED: Registry | null = null;

export function loadRegistry(): Registry {
  if (CACHED) return CACHED;

  const errors: ValidationError[] = [];
  const typologies = new Map<string, Typology>();
  const typologyIds = new Set<string>();

  const rawTypos = (typologiesFile as { typologies?: unknown[] }).typologies;
  if (!Array.isArray(rawTypos)) {
    throw new ArchitectureRegistryError([
      { path: '/typologies', message: 'typologies.json missing "typologies" array' },
    ]);
  }
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

  const styleGuidesById = new Map<string, StyleGuide>();
  const styleGuideOrder: string[] = [];

  RAW_GUIDES.forEach((g, i) => {
    const path = `/styleGuides/${i}`;
    const errs = validateStyleGuide(g, path);
    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }
    const typed = g as StyleGuide;
    if (styleGuidesById.has(typed.id)) {
      errors.push({ path: `${path}/id`, message: `duplicate styleGuide id ${JSON.stringify(typed.id)}` });
      return;
    }
    const refErrs = validateStyleGuideRefs(typed, typologyIds, path);
    if (refErrs.length > 0) {
      errors.push(...refErrs);
      return;
    }
    styleGuidesById.set(typed.id, typed);
    styleGuideOrder.push(typed.id);
  });

  if (errors.length > 0) {
    throw new ArchitectureRegistryError(errors);
  }

  CACHED = {
    typologies, typologyIds,
    styleGuidesById,
    styleGuideOrder: Object.freeze([...styleGuideOrder]),
  };
  return CACHED;
}

/** Test-only: drop the cache. NOT exposed via package index. */
export function _resetRegistryCacheForTests(): void {
  CACHED = null;
}

export interface StyleGuideMeta {
  id: string;
  cultureId: string;
  dateRange: [number, number];
  typologyCount: number;
}

export function listStyleGuideMeta(): StyleGuideMeta[] {
  const reg = loadRegistry();
  return reg.styleGuideOrder.map(id => {
    const g = reg.styleGuidesById.get(id)!;
    return {
      id: g.id,
      cultureId: g.styleSheet.cultureId,
      dateRange: g.styleSheet.dateRange,
      typologyCount: g.typologyWeights.length,
    };
  });
}

export function getStyleGuide(id: string): StyleGuide | null {
  return loadRegistry().styleGuidesById.get(id) ?? null;
}

export function getTypology(id: string): Typology | null {
  return loadRegistry().typologies.get(id) ?? null;
}

export { ArchitectureSchemaError };
