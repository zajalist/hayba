import type { BindingRequest } from './types.js';

/** FNV-1a 64-bit hash → 16-hex-digit string. Deterministic across machines. */
export function hashPrompt(system: string, user: string): string {
  const MASK64 = (1n << 64n) - 1n;
  let h = 0xCBF29CE484222325n;
  const prime = 0x100000001B3n;
  const combined = system + '' + user;
  for (let i = 0; i < combined.length; i++) {
    h = (h ^ BigInt(combined.charCodeAt(i))) & MASK64;
    h = (h * prime) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

const SYSTEM_PROMPT = [
  'You generate architectural element profiles for Hayba — a deterministic',
  'procedural architecture pipeline. For each named profile slot, emit a',
  'single <svg> with one <path d="..."/> matching the slot\'s hint and viewBox.',
  '',
  'Supported SVG path commands: M, L, H, V, Z (and their lowercase relatives).',
  'NO curve commands (C, Q, A). All polygons are straight-line.',
  '',
  'Hint contract:',
  '  - "symmetric-half": all path points must have x >= 0 (path is revolved',
  '    around the Y axis at x=0).',
  '  - "closed-path":    polygon outline. Centered viewBoxes (e.g. -100 -100 200 200)',
  '    produce symmetric output around (0,0).',
  '  - "open-path":      open polyline. Used for sweep paths.',
  '  - "tileable":       seamless edges. The pattern is tiled along a surface.',
  '',
  'Output MUST be strict JSON with this shape (no commentary, no markdown fences):',
  '{',
  '  "profiles": { "<slotName>": "<svg ...>...</svg>", ... },',
  '  "params":   { "<paramName>": <number-or-string>, ... },',
  '  "rationale": "one-paragraph design note explaining how the SVG reads as the culture/era"',
  '}',
  '',
  'Every numeric param must be in its declared range. Every required profile',
  'slot must appear. Coordinates in millimeters. The downstream engine converts to meters.',
].join('\n');

export function buildPrompt(req: BindingRequest): { system: string; user: string } {
  const { element, styleSheet } = req;

  const slots = element.profileSlots.map((slot) => {
    const bbox = slot.bbox ? ` viewBox="${slot.bbox.join(' ')}"` : '';
    return `  - ${slot.name} [${slot.hint}${bbox}]: ${slot.description}`;
  }).join('\n');

  const params = element.paramSchema.map((slot) => {
    if (slot.kind === 'enum') {
      return `  - ${slot.name} (enum): one of ${(slot.choices ?? []).map(c => JSON.stringify(c)).join(', ')}; default ${JSON.stringify(slot.default)}`;
    }
    const range = slot.range ? `range [${slot.range[0]}, ${slot.range[1]}]` : 'unconstrained';
    return `  - ${slot.name} (${slot.kind}): ${range}; default ${slot.default}`;
  }).join('\n');

  const ornamentation = styleSheet.core.ornamentation.length
    ? styleSheet.core.ornamentation.join(', ')
    : '(none)';

  const user = [
    `Element: ${element.id}  (category: ${element.category})`,
    `Style sheet: ${styleSheet.id}  (culture: ${styleSheet.cultureId}; dateRange: ${styleSheet.dateRange[0]}–${styleSheet.dateRange[1]})`,
    `Primary material: ${styleSheet.core.primaryMaterial}${styleSheet.core.secondaryMaterial ? `   Secondary: ${styleSheet.core.secondaryMaterial}` : ''}`,
    `Roof type: ${styleSheet.core.roofType}`,
    `Ornamentation pool: ${ornamentation}`,
    '',
    'Required profile slots:',
    slots,
    '',
    'Required parameters:',
    params,
    '',
    'Generate the binding JSON now. Strict JSON only, no markdown fences.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}
