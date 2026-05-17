/**
 * Finial element generator. Pure revolve of a symmetric-half silhouette around
 * the Y axis. Used for rooftop spires, urns, ornamental caps.
 */

import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { parseSvgProfile } from '../svg-parse.js';
import { revolve } from '../primitives.js';

export function finialGraph(b: ElementBinding): Mesh {
  const segments = Number(b.params.revolve_segments);
  const profile = parseSvgProfile(b.profiles.profile, 'symmetric-half');
  return revolve(profile, 'Y', segments, 360);
}
