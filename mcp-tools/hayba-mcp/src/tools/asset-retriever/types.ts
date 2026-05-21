export type AssetSource = 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown';

export interface AssetDoc {
  path: string;          // /Game/...
  name: string;          // basename
  class: string;         // StaticMesh, Material, ...
  tags: string[];        // from UE asset registry or external metadata sidecar
  source: AssetSource;
  lastModified: number;  // unix epoch ms
}

/** Infer source from a /Game/ path prefix. */
export function inferSource(path: string): AssetSource {
  if (/^\/Game\/Hayba\/Polyhaven\//i.test(path)) return 'polyhaven';
  if (/^\/Game\/Hayba\/AmbientCG\//i.test(path)) return 'ambientcg';
  if (/^\/Game\/Hayba\/Sketchfab\//i.test(path)) return 'sketchfab';
  if (/^\/Game\/Hayba\/Fab\//i.test(path)) return 'fab';
  if (/^\/Game\//.test(path)) return 'project';
  return 'unknown';
}
