import {
  FOOTPRINT_KINDS, PRIMARY_MATERIALS, ROOF_TYPES,
  type FootprintShape, type FootprintKind,
  type Typology, type StyleSheet, type StyleGuide,
} from './schema.js';

export interface ValidationError {
  path: string;       // JSON-pointer style, e.g. "/typologies/3/footprint/aspectRatio"
  message: string;
}

export class ArchitectureSchemaError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`@hayba/architecture: ${errors.length} validation error(s)`);
    this.name = 'ArchitectureSchemaError';
  }
}

/** Shared helper: `[min, max]` tuple with min ≤ max and both finite. */
export function validateRange(
  value: unknown, path: string, opts: { minAllowed?: number } = {},
): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!Array.isArray(value) || value.length !== 2) {
    return [{ path, message: 'expected [min, max] tuple of length 2' }];
  }
  const [lo, hi] = value;
  if (typeof lo !== 'number' || !Number.isFinite(lo)) {
    errs.push({ path: `${path}/0`, message: 'min must be a finite number' });
  }
  if (typeof hi !== 'number' || !Number.isFinite(hi)) {
    errs.push({ path: `${path}/1`, message: 'max must be a finite number' });
  }
  if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
    errs.push({ path, message: `min (${lo}) must be ≤ max (${hi})` });
  }
  if (opts.minAllowed !== undefined && typeof lo === 'number' && lo < opts.minAllowed) {
    errs.push({ path: `${path}/0`, message: `min must be ≥ ${opts.minAllowed}` });
  }
  return errs;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateFootprintShape(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !(FOOTPRINT_KINDS as readonly string[]).includes(kind)) {
    return [{
      path: `${path}/kind`,
      message: `unknown footprint kind ${JSON.stringify(kind)}; expected one of ${FOOTPRINT_KINDS.join(', ')}`,
    }];
  }
  const k = kind as FootprintKind;
  const errs: ValidationError[] = [];
  switch (k) {
    case 'rectangle':
      errs.push(...validateRange(value.aspectRatio, `${path}/aspectRatio`, { minAllowed: 0 }));
      errs.push(...validateRange(value.areaRange,   `${path}/areaRange`,   { minAllowed: 0 }));
      break;
    case 'linear-row':
      errs.push(...validateRange(value.widthRange, `${path}/widthRange`, { minAllowed: 0 }));
      errs.push(...validateRange(value.depthRange, `${path}/depthRange`, { minAllowed: 0 }));
      break;
    case 'L-shape':
      errs.push(...validateRange(value.wingDepth,         `${path}/wingDepth`,         { minAllowed: 0 }));
      errs.push(...validateRange(value.courtyardFraction, `${path}/courtyardFraction`, { minAllowed: 0 }));
      break;
    case 'U-shape':
      errs.push(...validateRange(value.wingDepth,    `${path}/wingDepth`,    { minAllowed: 0 }));
      errs.push(...validateRange(value.openingWidth, `${path}/openingWidth`, { minAllowed: 0 }));
      break;
    case 'courtyard':
      errs.push(...validateRange(value.courtyardFraction, `${path}/courtyardFraction`, { minAllowed: 0 }));
      errs.push(...validateRange(value.wingDepth,         `${path}/wingDepth`,         { minAllowed: 0 }));
      break;
  }
  return errs;
}

export function isFootprintShape(v: unknown): v is FootprintShape {
  return validateFootprintShape(v, '/').length === 0;
}

export function validateTypology(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  errs.push(...validateFootprintShape(value.footprint, `${path}/footprint`));
  errs.push(...validateRange(value.storyRange, `${path}/storyRange`, { minAllowed: 1 }));
  errs.push(...validateRange(value.fenestrationDensity, `${path}/fenestrationDensity`, { minAllowed: 0 }));
  if (Array.isArray(value.fenestrationDensity) && value.fenestrationDensity.length === 2) {
    const hi = value.fenestrationDensity[1];
    if (typeof hi === 'number' && hi > 1) {
      errs.push({
        path: `${path}/fenestrationDensity/1`,
        message: `max must be ≤ 1 (got ${hi})`,
      });
    }
  }
  if (value.pathfindingHints !== undefined) {
    if (!isPlainObject(value.pathfindingHints)) {
      errs.push({ path: `${path}/pathfindingHints`, message: 'expected an object' });
    } else {
      for (const [k, v] of Object.entries(value.pathfindingHints)) {
        if (typeof v !== 'string') {
          errs.push({
            path: `${path}/pathfindingHints/${k}`,
            message: 'expected string value',
          });
        }
      }
    }
  }
  return errs;
}

export function isTypology(v: unknown): v is Typology {
  return validateTypology(v, '/').length === 0;
}

function validateFeatureBundle(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every(item => typeof item === 'string')) continue;
    errs.push({
      path: `${path}/${k}`,
      message: 'expected string or string[] value',
    });
  }
  return errs;
}

export function validateStyleSheet(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  if (typeof value.cultureId !== 'string' || value.cultureId.length === 0) {
    errs.push({ path: `${path}/cultureId`, message: 'cultureId must be a non-empty string' });
  }
  errs.push(...validateRange(value.dateRange, `${path}/dateRange`));

  const core = value.core;
  if (!isPlainObject(core)) {
    errs.push({ path: `${path}/core`, message: 'expected an object' });
  } else {
    if (!(PRIMARY_MATERIALS as readonly string[]).includes(core.primaryMaterial as string)) {
      errs.push({
        path: `${path}/core/primaryMaterial`,
        message: `unknown primaryMaterial ${JSON.stringify(core.primaryMaterial)}; expected one of ${PRIMARY_MATERIALS.join(', ')}`,
      });
    }
    if (core.secondaryMaterial !== undefined &&
        !(PRIMARY_MATERIALS as readonly string[]).includes(core.secondaryMaterial as string)) {
      errs.push({
        path: `${path}/core/secondaryMaterial`,
        message: `unknown secondaryMaterial ${JSON.stringify(core.secondaryMaterial)}`,
      });
    }
    if (!(ROOF_TYPES as readonly string[]).includes(core.roofType as string)) {
      errs.push({
        path: `${path}/core/roofType`,
        message: `unknown roofType ${JSON.stringify(core.roofType)}; expected one of ${ROOF_TYPES.join(', ')}`,
      });
    }
    if (!Array.isArray(core.ornamentation) ||
        !core.ornamentation.every(s => typeof s === 'string')) {
      errs.push({
        path: `${path}/core/ornamentation`,
        message: 'expected array of strings',
      });
    }
  }
  errs.push(...validateFeatureBundle(value.extras, `${path}/extras`));
  return errs;
}

export function isStyleSheet(v: unknown): v is StyleSheet {
  return validateStyleSheet(v, '/').length === 0;
}

export function validateStyleGuide(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  errs.push(...validateStyleSheet(value.styleSheet, `${path}/styleSheet`));

  if (!Array.isArray(value.typologyWeights)) {
    errs.push({ path: `${path}/typologyWeights`, message: 'expected array' });
  } else if (value.typologyWeights.length === 0) {
    errs.push({ path: `${path}/typologyWeights`, message: 'must list at least one typology' });
  } else {
    value.typologyWeights.forEach((entry, i) => {
      const ePath = `${path}/typologyWeights/${i}`;
      if (!isPlainObject(entry)) {
        errs.push({ path: ePath, message: 'expected an object' });
        return;
      }
      if (typeof entry.typologyId !== 'string' || entry.typologyId.length === 0) {
        errs.push({ path: `${ePath}/typologyId`, message: 'typologyId must be a non-empty string' });
      }
      if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight <= 0) {
        errs.push({ path: `${ePath}/weight`, message: 'weight must be a positive finite number' });
      }
    });
  }
  return errs;
}

export function isStyleGuide(v: unknown): v is StyleGuide {
  return validateStyleGuide(v, '/').length === 0;
}

/**
 * Cross-reference check: every `typologyId` referenced from `guide.typologyWeights`
 * must exist in `knownTypologyIds`. Run AFTER `validateStyleGuide`; assumes
 * the guide is structurally valid.
 */
export function validateStyleGuideRefs(
  guide: StyleGuide, knownTypologyIds: ReadonlySet<string>, path: string,
): ValidationError[] {
  const errs: ValidationError[] = [];
  guide.typologyWeights.forEach((entry, i) => {
    if (!knownTypologyIds.has(entry.typologyId)) {
      errs.push({
        path: `${path}/typologyWeights/${i}/typologyId`,
        message: `unknown typologyId ${JSON.stringify(entry.typologyId)}`,
      });
    }
  });
  return errs;
}
