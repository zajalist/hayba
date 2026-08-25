// Work out which PBR slot each texture in a downloaded set belongs to.
//
// An ambientCG or PolyHaven download lands as a pile of files named by
// convention -- Rock023_2K-JPG_Color.jpg, _NormalGL.jpg, _Roughness.jpg -- and
// without this they import as loose textures that someone has to wire by hand,
// which is most of the reason texture acquisition has not felt useful.
//
// Pure on purpose: naming conventions are where the judgement lives, so the
// judgement is unit-testable without an editor, a download, or a project.

/** The slots we can wire. Deliberately closed -- a map we cannot place is
 *  reported as unrecognised rather than guessed into the wrong input. */
export type MapRole =
  | 'base_color'
  | 'normal'
  | 'roughness'
  | 'metallic'
  | 'ambient_occlusion'
  | 'displacement'
  | 'opacity'
  | 'emissive'
  | 'specular';

export interface ClassifiedMap {
  role: MapRole;
  /** The texture as given (path or asset name). */
  source: string;
  /** Which token matched, so a surprising classification can be explained. */
  matched: string;
  /** Normal maps only: OpenGL green-up vs DirectX green-down. */
  normalConvention?: 'gl' | 'dx';
}

export interface TextureSet {
  maps: ClassifiedMap[];
  /** Files that matched no known convention. Never silently dropped. */
  unrecognised: string[];
  /** Roles matched by more than one file, with the losers listed. The first
   *  match wins; the rest are reported so a mis-pick is visible. */
  ambiguous: Array<{ role: MapRole; chosen: string; alsoMatched: string[] }>;
}

/**
 * Ordered longest-token-first, because the short tokens are substrings of the
 * long ones. "AmbientOcclusion" contains "occlusion"; "NormalGL" contains
 * "normal"; a naive pass would classify half a set as the wrong thing.
 */
const CONVENTIONS: Array<{ role: MapRole; tokens: string[] }> = [
  { role: 'ambient_occlusion', tokens: ['ambientocclusion', 'ambient_occlusion', 'occlusion', '_ao', '-ao', 'ao'] },
  { role: 'base_color', tokens: ['basecolor', 'base_color', 'albedo', 'diffuse', 'diff', 'color', 'col', '_alb'] },
  { role: 'displacement', tokens: ['displacement', 'displace', 'height', 'disp', 'bump'] },
  { role: 'normal', tokens: ['normalgl', 'normaldx', 'normal_gl', 'normal_dx', 'normal', 'nrm', '_nor', 'norm'] },
  { role: 'roughness', tokens: ['roughness', 'rough', '_rgh'] },
  { role: 'metallic', tokens: ['metalness', 'metallic', 'metal', '_mtl'] },
  { role: 'opacity', tokens: ['opacity', 'alpha', 'mask'] },
  { role: 'emissive', tokens: ['emissive', 'emission', 'emit'] },
  { role: 'specular', tokens: ['specular', 'spec'] },
];

/** Strip directories, extension, and the resolution/format noise that sits
 *  between the asset id and the map name (`Rock023_2K-JPG_Color`). */
function stem(source: string): string {
  const base = source.split(/[\\/]/).pop() ?? source;
  return base.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

function classifyOne(source: string): { role: MapRole; matched: string } | null {
  const s = stem(source);

  // Match against the tail first. A file called `bark_normal_2k` should be a
  // normal map even though `bark` might one day be a token; what the map IS
  // conventionally comes last in these names.
  for (const { role, tokens } of CONVENTIONS) {
    for (const t of tokens) {
      const re = new RegExp(`(^|[^a-z])${t.replace(/^[-_]/, '')}([^a-z]|$)`, 'i');
      if (re.test(s)) return { role, matched: t.replace(/^[-_]/, '') };
    }
  }
  return null;
}

function normalConvention(source: string): 'gl' | 'dx' | undefined {
  const s = stem(source);
  if (/normal[_-]?gl|opengl/.test(s)) return 'gl';
  if (/normal[_-]?dx|directx/.test(s)) return 'dx';
  return undefined;
}

/**
 * Classify a downloaded texture set.
 *
 * Order matters for `ambiguous`: the first file given wins a contested role,
 * so callers that care should pass their preferred file first. Every input is
 * accounted for in exactly one of `maps`, `unrecognised`, or an `ambiguous`
 * entry's `alsoMatched` -- nothing is dropped in silence.
 */
export function classifyTextureSet(sources: readonly string[]): TextureSet {
  const maps: ClassifiedMap[] = [];
  const unrecognised: string[] = [];
  const contested = new Map<MapRole, string[]>();

  for (const source of sources) {
    const hit = classifyOne(source);
    if (!hit) {
      unrecognised.push(source);
      continue;
    }
    const taken = maps.find((m) => m.role === hit.role);
    if (taken) {
      contested.set(hit.role, [...(contested.get(hit.role) ?? []), source]);
      continue;
    }
    const entry: ClassifiedMap = { role: hit.role, source, matched: hit.matched };
    if (hit.role === 'normal') {
      const c = normalConvention(source);
      if (c) entry.normalConvention = c;
    }
    maps.push(entry);
  }

  const ambiguous = [...contested.entries()].map(([role, alsoMatched]) => ({
    role,
    chosen: maps.find((m) => m.role === role)!.source,
    alsoMatched,
  }));

  return { maps, unrecognised, ambiguous };
}

/** The material input each role connects to, by UE's own property names. */
export const ROLE_TO_MATERIAL_INPUT: Record<MapRole, string> = {
  base_color: 'BaseColor',
  normal: 'Normal',
  roughness: 'Roughness',
  metallic: 'Metallic',
  ambient_occlusion: 'AmbientOcclusion',
  displacement: 'Displacement',
  opacity: 'OpacityMask',
  emissive: 'EmissiveColor',
  specular: 'Specular',
};

/** Roles whose data is linear, not colour. Sampling these as sRGB is the
 *  single most common way a generated material comes out subtly wrong. */
export const LINEAR_ROLES: ReadonlySet<MapRole> = new Set<MapRole>([
  'normal', 'roughness', 'metallic', 'ambient_occlusion', 'displacement', 'opacity', 'specular',
]);

export interface MaterialPlanNode {
  id: string;
  role: MapRole;
  texture: string;
  /** UE's EMaterialSamplerType value, prefix included -- that is the spelling
   *  the reflection passthrough accepts. Wrong here and the material compiles
   *  and looks wrong, which nothing reports. */
  samplerType: 'SAMPLERTYPE_Color' | 'SAMPLERTYPE_LinearColor' | 'SAMPLERTYPE_Normal';
  connectsTo: string;
}

export interface MaterialPlan {
  nodes: MaterialPlanNode[];
  unrecognised: string[];
  ambiguous: TextureSet['ambiguous'];
  /** Roles with no texture. Reported so "no metallic map" is a stated fact
   *  rather than something the caller has to infer from absence. */
  missing: MapRole[];
}

/** Turn a classified set into the graph to build. Still pure: no editor, no
 *  asset paths resolved, nothing created. */
export function planMaterial(set: TextureSet): MaterialPlan {
  const nodes = set.maps.map((m, i) => ({
    id: `tex_${m.role}_${i}`,
    role: m.role,
    texture: m.source,
    samplerType: (m.role === 'normal'
      ? 'SAMPLERTYPE_Normal'
      : LINEAR_ROLES.has(m.role)
        ? 'SAMPLERTYPE_LinearColor'
        : 'SAMPLERTYPE_Color') as MaterialPlanNode['samplerType'],
    connectsTo: ROLE_TO_MATERIAL_INPUT[m.role],
  }));

  const present = new Set(set.maps.map((m) => m.role));
  const missing = (Object.keys(ROLE_TO_MATERIAL_INPUT) as MapRole[]).filter((r) => !present.has(r));

  return { nodes, unrecognised: set.unrecognised, ambiguous: set.ambiguous, missing };
}
