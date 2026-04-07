/**
 * hayba_brainstorm_terrain
 *
 * Guided, multi-step terrain brainstorm. The AI calls this tool once per step,
 * advancing through a hardcoded flow:
 *
 *   start → biome → scale → features → name → layout → preview → bake → foliage → done
 *
 * At each step the tool returns a prompt for the AI to present to the user,
 * along with the choices the user should pick from. The AI presents the question,
 * collects the answer, then calls the tool again with the next step + answer.
 *
 * At the "layout" step the tool unlocks the Zone Painter so the user can sketch
 * the terrain layout. The AI waits for zone submission, then advances to "bake".
 */


import type { ToolResult } from './hayba-bake-terrain.js';
import { createProject, DEFAULT_PROJECTS_BASE } from '../projects.js';
import { config } from '../config.js';

async function unlockPainterViaApi(projectId: string, phase: 'a' | 'b'): Promise<void> {
  const url = `http://${config.dashboardHost}:${config.dashboardPort}/api/zones/painter-session`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, phase }),
  });
}

export type BrainstormStep =
  | 'start'
  | 'biome'
  | 'scale'
  | 'features'
  | 'name'
  | 'layout'
  | 'preview'
  | 'bake'
  | 'foliage'
  | 'done';

interface StepResult {
  step: BrainstormStep;
  nextStep: BrainstormStep;
  prompt: string;
  choices?: Record<string, string>;  // key → description shown to user
  action?: string;                   // side effect description
  painterUrl?: string;
  projectId?: string;
  projectName?: string;
  waitForUser: boolean;              // true = AI must wait for user before calling next step
}

export async function brainstormTerrainHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const step = (args.step as BrainstormStep | undefined) ?? 'start';
  const answer = args.answer as string | undefined;
  const projectId = args.projectId as string | undefined;
  const projectName = (args.projectName as string | undefined);

  let result: StepResult;

  switch (step) {

    case 'start': {
      result = {
        step: 'start',
        nextStep: 'biome',
        prompt: `Let's build a terrain together. What kind of world are you making? Describe the biome, climate, or vibe — or pick one of these to start:`,
        choices: {
          A: 'Muddy lowland marsh / bayou swamp',
          B: 'Rocky alpine highlands with snow',
          C: 'Arid desert canyons and mesas',
          D: 'Dense temperate rainforest',
          E: 'Volcanic wasteland with lava fields',
          F: 'Custom — describe your own',
        },
        waitForUser: true,
      };
      break;
    }

    case 'biome': {
      result = {
        step: 'biome',
        nextStep: 'scale',
        prompt: `Got it — "${answer}". How large should this terrain be?`,
        choices: {
          A: 'Small (2–4 km²) — dense, intimate, claustrophobic',
          B: 'Mid (8–10 km²) — open with distinct sub-zones',
          C: 'Large (16+ km²) — epic, multiple biome areas',
        },
        waitForUser: true,
      };
      break;
    }

    case 'scale': {
      result = {
        step: 'scale',
        nextStep: 'features',
        prompt: `Good. What should be the dominant terrain feature players navigate around?`,
        choices: {
          A: 'Water channels / rivers cutting through the land',
          B: 'A large central body of water with radiating flatlands',
          C: 'Raised ridges and embankments — high ground vs low ground',
          D: 'Dense hummocks and root tangles — no clear paths',
          E: 'Mix of multiple features at smaller scale',
        },
        waitForUser: true,
      };
      break;
    }

    case 'features': {
      result = {
        step: 'features',
        nextStep: 'name',
        prompt: `Perfect. Now let's sketch the layout. I'm opening the Zone Painter — you'll see a blank canvas. Paint where you want terrain zones (ridges, channels, flat areas) to go. Use one zone per feature type and hit Submit when done.`,
        choices: {
          A: 'Open Zone Painter now',
        },
        waitForUser: true,
      };
      break;
    }

    case 'name': {
      result = {
        step: 'name',
        nextStep: 'layout',
        prompt: `What would you like to name this landscape scene?`,
        waitForUser: true,
      };
      break;
    }

    case 'layout': {
      // Create project and unlock painter via HTTP API (shared with dashboard process)
      const name = answer?.trim() || projectName || 'New Scene';
      const project = await createProject(name, base);
      await unlockPainterViaApi(project.id, 'a');

      const url = `http://${config.dashboardHost}:${config.dashboardPort}/#project/${project.id}/zones`;
      result = {
        step: 'layout',
        nextStep: 'preview',
        prompt: `Zone Painter is unlocked for project "${name}".\n\nOpen this URL — it will land directly on the Zone Painter:\n${url}\n\nPaint your terrain layout zones and click Submit. Then come back and tell me you're done.`,
        action: `Created project "${name}" (${project.id}). Zone Painter unlocked at Phase A.`,
        painterUrl: url,
        projectId: project.id,
        projectName: name,
        waitForUser: true,
      };
      break;
    }

    case 'preview': {
      // Zones submitted — generate the Gaea graph and open it for the user to review before baking
      result = {
        step: 'preview',
        nextStep: 'bake',
        prompt: `Zones received. I've generated the Gaea terrain graph based on your layout and opened it in Gaea so you can review and tweak it before baking.\n\nTake a look — adjust any nodes, parameters, or connections you'd like. When you're happy with it, come back and tell me to proceed.`,
        action: `Call hayba_read_zones to get zone mask PNG paths and descriptions. Build a Gaea graph where each zone mask is loaded via a File node (params: { FileName: "<absolute_path_to_mask.png>" }) and connected as a mask/input to drive the relevant terrain feature (e.g. the swampy zone mask feeds Erosion2's Mask port to concentrate water channels there). Pass name="${projectName ?? 'the landscape name'}" to hayba_create_terrain so the .terrain file is named after the landscape. Then call hayba_open_in_gaea so the user can review and tweak in Gaea before baking.`,
        projectId,
        projectName,
        waitForUser: true,
      };
      break;
    }

    case 'bake': {
      // User confirmed they're happy in Gaea — now bake and import
      result = {
        step: 'bake',
        nextStep: 'foliage',
        prompt: `Baking terrain and importing into Unreal Engine. This may take a minute — you'll see the landscape appear in your level.`,
        action: `Call hayba_bake_terrain on the already-open Gaea file, then hayba_import_landscape. After import, call hayba_set_painter_heightmap with the baked heightmap path and projectId="${projectId}" to enable Phase B.`,
        projectId,
        waitForUser: false,
      };
      break;
    }

    case 'foliage': {
      // Terrain is imported — time for foliage/placement zones
      const url = `http://${config.dashboardHost}:${config.dashboardPort}`;
      if (projectId) {
        await unlockPainterViaApi(projectId, 'b');
      }
      result = {
        step: 'foliage',
        nextStep: 'done',
        prompt: `Terrain is in Unreal. Now let's place foliage and props.\n\nI've switched the Zone Painter to Phase B — you'll see the baked heightmap as the background. Paint placement zones (forests, vegetation patches, rocky areas, scattered props) and hit Submit when done.`,
        action: projectId ? `Zone Painter unlocked at Phase B for project ${projectId}.` : `Provide projectId to unlock Phase B.`,
        painterUrl: url,
        projectId,
        waitForUser: true,
      };
      break;
    }

    case 'done': {
      result = {
        step: 'done',
        nextStep: 'done',
        prompt: `Foliage zones submitted. The full scene workflow is complete:\n\n✓ Terrain generated in Gaea\n✓ Landscape imported into UE5\n✓ Placement zones ready for PCG\n\nYou can now use hayba_read_zones to feed the placement zones into PCG graphs, or call hayba_brainstorm_terrain again to start a new scene.`,
        waitForUser: false,
      };
      break;
    }

    default: {
      return {
        content: [{ type: 'text', text: `Unknown step "${step}". Valid steps: start, biome, scale, features, layout, bake, foliage, done.` }],
        isError: true,
      };
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
