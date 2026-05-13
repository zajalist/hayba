import { z } from 'zod';
import {
  listStyleGuides as engineListStyleGuides,
  getStyleGuideTool as engineGetStyleGuide,
  getTypologyTool as engineGetTypology,
  validateStyleGuideTool as engineValidateStyleGuide,
} from '@hayba/architecture';

/* ─────────────────────  schemas  ───────────────────── */

export const listStyleGuidesSchema = z.object({});

export const getStyleGuideSchema = z.object({
  id: z.string().describe('StyleGuide id, e.g. "medieval-european-gothic"'),
});

export const getTypologySchema = z.object({
  id: z.string().describe('Typology id, e.g. "peasant_home"'),
});

export const validateStyleGuideSchema = z.object({
  json: z.record(z.string(), z.unknown()).describe('Candidate StyleGuide JSON to validate against the A1 schema'),
});

/* ─────────────────────  handlers  ───────────────────── */

export function listStyleGuides(_params: z.infer<typeof listStyleGuidesSchema>) {
  return engineListStyleGuides();
}

export function getStyleGuide(params: z.infer<typeof getStyleGuideSchema>) {
  return engineGetStyleGuide(params);
}

export function getTypology(params: z.infer<typeof getTypologySchema>) {
  return engineGetTypology(params);
}

export function validateStyleGuide(params: z.infer<typeof validateStyleGuideSchema>) {
  return engineValidateStyleGuide(params);
}
