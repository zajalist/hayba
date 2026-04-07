/**
 * hayba_brainstorm_terrain
 *
 * Guided, multi-step terrain brainstorm. The AI calls this tool once per step,
 * advancing through a hardcoded flow:
 *
 *   start → biome → scale → features → layout → bake → foliage → done
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
import { unlockPainter } from '../zones.js';
import { config } from '../config.js';

export type BrainstormStep =
  | 'start'
  | 'biome'
  | 'scale'
  | 'features'
  | 'layout'
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
  waitForUser: boolean;              // true = AI must wait for user before calling next step
}

export async function brainstormTerrainHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const step = (args.step as BrainstormStep | undefined) ?? 'start';
  const answer = args.answer as string | undefined;
  const projectId = args.projectId as string | undefined;
  const projectName = args.projectName as string | undefined;

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
        nextStep: 'layout',
        prompt: `Perfect. Now let's sketch the layout. I'm opening the Zone Painter — you'll see a blank canvas. Paint where you want terrain zones (ridges, channels, flat areas) to go. Use one zone per feature type and hit Submit when done.`,
        choices: {
          A: 'Open Zone Painter now',
        },
        waitForUser: true,
      };
      break;
    }

    case 'layout': {
      // Create project and unlock painter
      const name = projectName ?? answer ?? 'New Scene';
      const project = await createProject(name, base);
      unlockPainter(project.id, 'a');

      const url = `http://${config.dashboardHost}:${config.dashboardPort}`;
      result = {
        step: 'layout',
        nextStep: 'bake',
        prompt: `Zone Painter is unlocked for project "${name}" (ID: ${project.id}).\n\nOpen ${url} → Projects → ${name} → Zone Painter.\n\nPaint your terrain layout zones and click Submit. Then come back and tell me you're done.`,
        action: `Created project "${name}" (${project.id}). Zone Painter unlocked at Phase A.`,
        painterUrl: url,
        projectId: project.id,
        waitForUser: true,
      };
      break;
    }

    case 'bake': {
      // User has submitted zones — now we want to bake
      // Return instructions for the AI to call hayba_create_terrain / hayba_bake_terrain
      result = {
        step: 'bake',
        nextStep: 'foliage',
        prompt: `Zones received. I'll now generate the Gaea terrain graph based on your layout and bake it. This may take a minute.\n\nAfter baking, I'll import it into Unreal Engine automatically. You'll see the landscape appear in your level.`,
        action: `Call hayba_create_terrain with the zone data as prompt context, then hayba_bake_terrain, then hayba_import_landscape. After import, call hayba_set_painter_heightmap with the baked heightmap path and projectId="${projectId}" to enable Phase B.`,
        projectId,
        waitForUser: false,
      };
      break;
    }

    case 'foliage': {
      // Terrain is imported — time for foliage/placement zones
      const url = `http://${config.dashboardHost}:${config.dashboardPort}`;
      if (projectId) {
        unlockPainter(projectId, 'b');
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
