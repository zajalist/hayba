import type { Graph, TemplateMeta, TemplateVariableContract } from "../types.js";
import * as desert from "./desert.js";
import * as mountains from "./mountains.js";
import * as tropical from "./tropical.js";
import * as volcanic from "./volcanic.js";

interface TemplateModule {
  meta: TemplateMeta;
  variables: TemplateVariableContract;
  build: (overrides?: Record<string, unknown>) => Graph;
}

const registry: TemplateModule[] = [desert, mountains, tropical, volcanic];

export function listTemplates(): TemplateMeta[] {
  return registry.map(t => ({ ...t.meta, variables: t.variables }));
}

export function getTemplate(name: string, overrides?: Record<string, unknown>): Graph | null {
  const mod = registry.find(t => t.meta.name === name);
  if (!mod) return null;
  return mod.build(overrides ?? {});
}

export function getTemplateVariables(name: string): TemplateVariableContract | null {
  const mod = registry.find(t => t.meta.name === name);
  return mod?.variables ?? null;
}
