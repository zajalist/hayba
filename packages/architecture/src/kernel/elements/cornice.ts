/**
 * Cornice element generator. Sweeps a cross-section profile along the X axis
 * (using loft between two copies of the profile at two X positions).
 *
 * - profile is a closed-path cross-section (the moulding's silhouette).
 * - length_m is the run of the cornice along the X axis.
 *
 * Result: a bar of cornice in engine coords (meters), centered at origin on X,
 * with the profile lying in the YZ plane.
 */

import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { parseSvgProfile } from '../svg-parse.js';
import { loft } from '../primitives.js';

export function corniceGraph(b: ElementBinding): Mesh {
  const length = Number(b.params.length_m);
  const profile = parseSvgProfile(b.profiles.profile, 'closed-path');

  // Loft the same profile between two X positions: -length/2 and +length/2.
  return loft(
    [profile, profile],
    [[-length / 2, 0, 0], [+length / 2, 0, 0]],
  );
}
