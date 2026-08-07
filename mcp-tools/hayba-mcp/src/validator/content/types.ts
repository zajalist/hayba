// Types for content validation — textures and meshes.
//
// Same split as the UI validator: the engine measures, this judges. The input is
// whatever texture_audit / mesh_audit return, so these rules are pure functions
// over data that already exists and are unit-testable without an editor.

import type { RuleCategory, Strictness } from '../config.js';

export interface TextureRow {
  path: string;
  format: string;
  size_x: number;
  size_y: number;
  memory_kb: number;
  lod_group: string;
  compression: string;
  /** Set by the audit when the name implies a role its compression contradicts. */
  outlier?: boolean;
}

export interface MeshRow {
  path: string;
  tris_lod0: number;
  lod_count: number;
  missing_lods?: boolean;
  material_slot_count: number;
  referencer_count: number;
}

export interface ContentSnapshot {
  textures?: TextureRow[];
  meshes?: MeshRow[];
  /** How many assets the audit looked at, vs how many rows came back. The
   *  audits return only the heaviest N, so rules must not read an absent row as
   *  a clean bill of health. */
  textures_scanned?: number;
  meshes_scanned?: number;
}

export type ContentSeverity = 'error' | 'warning' | 'info';

export interface ContentFinding {
  ruleId: string;
  category: RuleCategory;
  severity: ContentSeverity;
  /** Asset the finding is about. */
  asset?: string;
  message: string;
  hint: string;
  data?: Record<string, unknown>;
}

export interface ContentThresholds {
  /** Texture memory above this is worth a look, in KB. */
  textureMemoryWarnKb: number;
  /** Any single texture above this is almost never deliberate. */
  textureMemoryErrorKb: number;
  /** Dimension above which a texture is "large" for mip purposes. */
  largeTextureDim: number;
  /** Triangle count above which a mesh wants LODs. */
  meshTriWarn: number;
  /** Material slots beyond this cost a draw call each. */
  materialSlotWarn: number;
}

export interface ContentRuleContext {
  snapshot: ContentSnapshot;
  strictness: Strictness;
  thresholds: ContentThresholds;
}

export interface ContentRule {
  id: string;
  category: RuleCategory;
  severity: ContentSeverity;
  minStrictness: Strictness;
  title: string;
  /** Which part of the snapshot this rule needs. Rules whose data is absent are
   *  reported as skipped rather than silently passing. */
  needs: 'textures' | 'meshes';
  evaluate: (ctx: ContentRuleContext) => ContentFinding[];
}

export interface ContentValidationResult {
  strictness: Strictness;
  findings: ContentFinding[];
  rules_evaluated: number;
  rules_skipped_no_data: string[];
  rules_disabled: string[];
  rules_below_strictness: string[];
  counts: Record<ContentSeverity, number>;
  /** Restated from the snapshot so a caller can see the audit was truncated and
   *  that "no findings" covers only the rows it was given. */
  coverage: {
    textures_reported: number;
    textures_scanned?: number;
    meshes_reported: number;
    meshes_scanned?: number;
    truncated: boolean;
  };
}
