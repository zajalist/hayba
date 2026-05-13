import {
  listStyleGuideMeta,
  getStyleGuide as registryGetStyleGuide,
  getTypology as registryGetTypology,
  type StyleGuideMeta,
} from './registry.js';
import { validateStyleGuide, type ValidationError } from './validate.js';
import type { StyleGuide, Typology } from './schema.js';

// ─── list_style_guides ──────────────────────────────────────────────────────

export interface ListStyleGuidesResult {
  guides: StyleGuideMeta[];
}

export function listStyleGuides(): ListStyleGuidesResult {
  return { guides: listStyleGuideMeta() };
}

// ─── get_style_guide ────────────────────────────────────────────────────────

export type GetStyleGuideResult =
  | { guide: StyleGuide }
  | { error: 'not_found'; id: string };

export function getStyleGuideTool(args: { id: string }): GetStyleGuideResult {
  const g = registryGetStyleGuide(args.id);
  if (!g) return { error: 'not_found', id: args.id };
  return { guide: g };
}

// ─── get_typology ────────────────────────────────────────────────────────────

export type GetTypologyResult =
  | { typology: Typology }
  | { error: 'not_found'; id: string };

export function getTypologyTool(args: { id: string }): GetTypologyResult {
  const t = registryGetTypology(args.id);
  if (!t) return { error: 'not_found', id: args.id };
  return { typology: t };
}

// ─── validate_style_guide ────────────────────────────────────────────────────

export type ValidateStyleGuideResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export function validateStyleGuideTool(args: { json: unknown }): ValidateStyleGuideResult {
  const errs = validateStyleGuide(args.json, '');
  if (errs.length === 0) return { ok: true };
  return { ok: false, errors: errs };
}
