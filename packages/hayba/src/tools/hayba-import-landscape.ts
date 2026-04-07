import { ensureConnected } from '../tcp-client.js';
import { readConventions } from '../conventions.js';
import type { SessionManager } from '../gaea/session.js';
import type { ToolResult } from './hayba-bake-terrain.js';

export async function importLandscapeHandler(
  args: Record<string, unknown>,
  session: SessionManager
): Promise<ToolResult> {
  // 1. Resolve heightmap path
  const heightmapPath = (args.heightmapPath as string | undefined) ?? session.lastBakedHeightmap ?? null;
  if (!heightmapPath) {
    return {
      content: [{ type: 'text', text: 'Error: no heightmap available — bake a terrain first or provide heightmapPath.' }],
      isError: true,
    };
  }

  // 2. Resolve landscape material
  let landscapeMaterial = args.landscapeMaterial as string | undefined;
  if (landscapeMaterial === undefined) {
    const projectRoot = args.projectRoot as string | undefined;
    const conventions = readConventions(projectRoot);
    const folder = conventions?.folders.landscapeMaterials;
    if (folder) {
      landscapeMaterial = folder;
    } else {
      return {
        content: [{ type: 'text', text:
          'No landscape material configured. Please provide a landscapeMaterial path (e.g. "/Game/Materials/Landscape/M_Terrain"), ' +
          'or run hayba_setup_conventions to set a default. Pass landscapeMaterial: "" to import without a material.'
        }],
        isError: false,
      };
    }
  }

  // 3. Send TCP command — C++ reads resolution from heightmap and computes scale
  const worldSizeKm = (args.worldSizeKm as number | undefined) ?? 8.0;
  const maxHeightM  = (args.maxHeightM  as number | undefined) ?? 600.0;
  const actorLabel  = (args.actorLabel  as string | undefined) ?? 'Hayba_Terrain';

  let response: { ok: boolean; data?: Record<string, unknown>; error?: string };
  try {
    const client = await ensureConnected();
    response = await client.send('import_landscape', {
      heightmapPath,
      worldSizeKm,
      maxHeightM,
      landscapeMaterial: landscapeMaterial ?? '',
      actorLabel,
    }, 60000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `TCP error: ${message}` }], isError: true };
  }

  if (!response.ok) {
    return { content: [{ type: 'text', text: `Import failed: ${response.error ?? 'unknown error'}` }], isError: true };
  }

  const data = response.data ?? {};
  const lines = [
    `Landscape imported successfully.`,
    `Actor: ${data.actorLabel ?? actorLabel}`,
    `Scale XY: ${data.scaleXY ?? '—'} cm/px`,
    `Scale Z:  ${data.scaleZ  ?? '—'}`,
    `Heightmap: ${heightmapPath}`,
    landscapeMaterial ? `Material: ${landscapeMaterial}` : `Material: (none)`,
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
