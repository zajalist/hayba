/**
 * Column element generator. Mathematically composes a column from its
 * 4 hand-authored / AI-emitted SVG profiles and 4 numeric parameters.
 *
 * Layout (Y-up, meters):
 *   y = 0                              ── ground line, bottom of base
 *   y = base_height_m                  ── bottom of shaft
 *   y = base_height_m + shaft_height_m ── bottom of capital
 *   y = total_height                   ── top of capital
 *
 * Subassemblies:
 *   - Base:    revolve(profiles.base, 360°)  positioned at y=0
 *   - Shaft:   revolve(profiles.shaft, 360°) positioned at y=base_height_m
 *   - Capital: loft([capital_bottom, capital_top]) between two Y positions
 */

import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { parseSvgProfile } from '../svg-parse.js';
import { revolve, loft, mergeMeshes, transform, translate } from '../primitives.js';

export function columnGraph(b: ElementBinding): Mesh {
  const baseH    = Number(b.params.base_height_m);
  const shaftH   = Number(b.params.shaft_height_m);
  const capH     = Number(b.params.capital_height_m);
  const segments = Number(b.params.revolve_segments);

  const baseProfile  = parseSvgProfile(b.profiles.base,           'symmetric-half');
  const shaftProfile = parseSvgProfile(b.profiles.shaft,          'symmetric-half');
  const capBot       = parseSvgProfile(b.profiles.capital_bottom, 'closed-path');
  const capTop       = parseSvgProfile(b.profiles.capital_top,    'closed-path');

  if (capBot.points.length !== capTop.points.length) {
    throw new Error(
      `columnGraph: capital_bottom (${capBot.points.length} points) and capital_top ` +
      `(${capTop.points.length} points) must have the same point count. ` +
      `Resample the SVG profiles to match before binding.`,
    );
  }

  const baseMesh = transform(
    revolve(baseProfile, 'Y', segments, 360),
    translate(0, 0, 0),
  );

  const shaftMesh = transform(
    revolve(shaftProfile, 'Y', segments, 360),
    translate(0, baseH, 0),
  );

  const capMesh = loft(
    [capBot, capTop],
    [[0, baseH + shaftH, 0], [0, baseH + shaftH + capH, 0]],
  );

  return mergeMeshes([baseMesh, shaftMesh, capMesh]);
}
