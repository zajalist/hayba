/**
 * hayba_ue_landscape_pipeline
 *
 * Guided, multi-step UE landscape project pipeline. The AI calls this tool once per step,
 * advancing through a hardcoded flow:
 *
 *   start → biome → scale → features → name → preview → bake → foliage → done
 *
 * At each step the tool returns a prompt for the AI to present to the user,
 * along with the choices the user should pick from. The AI presents the question,
 * collects the answer, then calls the tool again with the next step + answer.
 *
 * At the "name" step the user provides the landscape name. The tool creates the
 * project and unlocks the Zone Painter immediately. The AI shares the painter URL
 * and waits for the user to submit zones before advancing to "preview".
 */


import type { ToolResult } from './hayba-bake-terrain.js';
import { createProject, DEFAULT_PROJECTS_BASE } from '../projects.js';
import { config } from '../config.js';
import type { SessionManager } from '../gaea/session.js';
import { getCurrentZones } from '../zones.js';
import { launchGaea, detectGaeaPath } from '../gaea/gaea-launcher.js';
import { searchGaeaArchetypes } from './search-gaea-archetypes.js';
import { layoutGraph } from '../gaea/layout-engine.js';

async function unlockPainterViaApi(projectId: string, phase: 'a' | 'b'): Promise<void> {
  const url = `http://${config.dashboardHost}:${config.dashboardPort}/api/zones/painter-session`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, phase }),
  });
}

export type UELandscapePipelineStep =
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
  step: UELandscapePipelineStep;
  nextStep: UELandscapePipelineStep;
  prompt: string;
  choices?: Record<string, string>;  // key → description shown to user
  action?: string;                   // side effect description
  painterUrl?: string;
  projectId?: string;
  projectName?: string;
  waitForUser: boolean;              // true = AI must wait for user before calling next step
}

export async function ueLandscapePipelineHandler(
  args: Record<string, unknown>,
  session?: SessionManager,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const step = (args.step as UELandscapePipelineStep | undefined) ?? 'start';
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
        action: `Pass biomeAnswer="${answer}" when calling step="scale".`,
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
        prompt: `Great — "${answer}". Before we open the Zone Painter, what would you like to name this landscape scene? (e.g. "Bayou Lowlands", "Cragger's Pass")\n\nOnce you have a name, call this tool with step="name" and answer=<the name>.`,
        action: `Pass featureAnswer="${answer}" and preserve biomeAnswer from step "biome" when calling step="name".`,
        waitForUser: true,
      };
      break;
    }

    case 'name': {
      // answer = the landscape name. Create project and open painter immediately.
      const name = answer?.trim() || 'New Scene';
      const project = await createProject(name, base);
      await unlockPainterViaApi(project.id, 'a');

      // Store biome/feature context in project for use in preview step
      const biomeAnswer = args.biomeAnswer as string | undefined;
      const featureAnswer = args.featureAnswer as string | undefined;

      const url = `http://${config.dashboardHost}:${config.dashboardPort}/#project/${project.id}/zones`;
      result = {
        step: 'name',
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
      // Zones submitted — automatically build the Gaea graph with zone masks and open for review
      const zoneSession = projectId ? await getCurrentZones(projectId, base) : null;
      const zones = zoneSession?.zones ?? [];

      // Collect biome/feature context from previous answers for archetype search
      const biomeAnswer = args.biomeAnswer as string | undefined;
      const featureAnswer = args.featureAnswer as string | undefined;
      const searchQuery = [biomeAnswer, featureAnswer].filter(Boolean).join(' ');

      // Search knowledge base for relevant archetypes based on user's biome and feature choices
      let archetypeSuggestions = '';
      if (searchQuery) {
        try {
          const archetypeResults = await searchGaeaArchetypes({
            query: searchQuery,
            limit: 3,
          });
          if (archetypeResults.archetypes.length > 0) {
            archetypeSuggestions = `\n\n**Relevant Terrain Archetypes from the knowledge base:**\n`;
            archetypeResults.archetypes.forEach((a, i) => {
              archetypeSuggestions += `${i + 1}. **${a.pattern_name}**: ${a.semantic_intent}\n   Nodes: ${a.core_topology.join(' → ')}\n`;
            });
          }
        } catch { /* non-fatal */ }
      }

      // Build graph: base terrain blended with mountain peaks inside each painted zone mask.
      // Masks are blurred before use so zone boundaries fade naturally into the landscape.
      type Node = { id: string; type: string; params: Record<string, string | number | boolean> };
      type Edge = { from: string; fromPort: string; to: string; toPort: string };
      const nodes: Node[] = [];
      const edges: Edge[] = [];

      // Foundation: flat-ish base + high-drama peaks available for masking in
      nodes.push({ id: "base",  type: "Perlin",   params: { Seed: 0, Scale: 0.25, Octaves: 4 } });
      nodes.push({ id: "peaks", type: "Mountain",  params: { Seed: 0, Scale: 1.5, Height: 0.9, Style: "Alpine" } });

      // Per-zone: raw painted mask → Blur for natural falloff → Combine blends base↔peaks inside zone
      // Zones accumulate: each blend feeds as the "In" of the next, so all zones coexist on one canvas.
      let currentSource = "base";  // if no zones, base terrain flows straight into post-processing
      let maskIdx = 0;
      for (const zone of zones) {
        if (!zone.maskPath) continue;
        const rawId    = `mask_raw_${maskIdx}`;
        const blurId   = `mask_blur_${maskIdx}`;
        const blendId  = `blend_${maskIdx}`;
        const prevBase = maskIdx === 0 ? "base" : `blend_${maskIdx - 1}`;

        // Load the painted zone bitmap
        nodes.push({ id: rawId,  type: "File", params: { FileName: zone.maskPath } });
        // Blur heavily so the painted boundary fades out across a wide area — kills hard edges
        nodes.push({ id: blurId, type: "Blur", params: { Radius: 0.08 } });
        edges.push({ from: rawId,  fromPort: "Out", to: blurId,  toPort: "In" });

        // Blend: outside mask value=0 → show prevBase; inside mask value=1 → show peaks
        // Mode "Blend" uses the Mask port as a linear mix weight, which is what we want.
        nodes.push({ id: blendId, type: "Combine", params: { Mode: "Blend" } });
        edges.push({ from: prevBase, fromPort: "Out", to: blendId, toPort: "In" });
        edges.push({ from: "peaks",  fromPort: "Out", to: blendId, toPort: "Input2" });
        edges.push({ from: blurId,   fromPort: "Out", to: blendId, toPort: "Mask" });

        currentSource = blendId;
        maskIdx++;
      }

      // Global post-processing on the full composite (all zones already baked in)
      nodes.push({ id: "rugged", type: "Rugged",    params: { Seed: 0 } });
      nodes.push({ id: "erode",  type: "Erosion2",  params: { Downcutting: 0.6, ErosionScale: 800, Seed: 0 } });
      nodes.push({ id: "level",  type: "Autolevel", params: {} });
      edges.push({ from: currentSource, fromPort: "Out", to: "rugged", toPort: "In" });
      edges.push({ from: "rugged",      fromPort: "Out", to: "erode",  toPort: "In" });
      edges.push({ from: "erode",       fromPort: "Out", to: "level",  toPort: "In" });

      // ── Graph invariant check ────────────────────────────────────────────────
      // Every non-source node must have at least one incoming edge.
      // Catch missing connections here rather than producing a broken Gaea file.
      // File nodes load from disk — they are sources with no incoming edge by design
      const sourceNodes = new Set(["base", "peaks", ...nodes.filter(n => n.type === "File").map(n => n.id)]);
      const nodesWithIncomingEdge = new Set(edges.map(e => e.to));
      const disconnected = nodes
        .filter(n => !sourceNodes.has(n.id) && !nodesWithIncomingEdge.has(n.id))
        .map(n => n.id);
      if (disconnected.length > 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Graph invariant violated — nodes have no incoming edge: ${disconnected.join(', ')}. Fix the edge list before sending to Gaea.`,
            nodes: nodes.map(n => n.id),
            edges: edges.map(e => `${e.from}:${e.fromPort} → ${e.to}:${e.toPort}`),
          }, null, 2) }],
          isError: true,
        };
      }

      // Apply DAG layout for clean node positioning
      const positioned = layoutGraph(nodes, edges);
      for (let i = 0; i < nodes.length; i++) {
        const match = positioned.find(p => p.id === nodes[i].id);
        if (match) {
          (nodes[i] as Record<string, unknown>).position = match.position;
        }
      }

      const graph = { nodes, edges };

      // Create terrain file and cook
      let terrainPath: string | null = null;
      let buildError: string | null = null;
      if (session) {
        try {
          await session.enqueue(async () => { await session.client.createGraph(graph, projectName ?? 'terrain'); });
          terrainPath = session.client.currentTerrainPath;
          if (terrainPath) session.setTerrainPath(terrainPath);
          await session.enqueue(async () => { await session.client.cook(); });
        } catch (e) {
          buildError = (e as Error).message;
        }

        // Open in Gaea for review
        if (terrainPath) {
          try {
            const gaeaExe = session.gaeaExePath || detectGaeaPath();
            if (gaeaExe) launchGaea(gaeaExe, terrainPath);
          } catch { /* non-fatal */ }
        }
      }

      const zoneNames = zones.map(z => `"${z.name}"`).join(', ');
      const zoneInfo  = zones.length > 0
        ? `Applied ${zones.length} zone mask(s): ${zoneNames}.`
        : 'No zones were submitted — using a default alpine mountain layout.';
      const statusLine = buildError ? `\n\nNote: cook failed (${buildError}) — you can cook manually inside Gaea.` : '';

      result = {
        step: 'preview',
        nextStep: 'bake',
        prompt: `Zones received. ${zoneInfo} The Gaea terrain graph has been generated and opened for review.${statusLine}${archetypeSuggestions}\n\nTake a look — adjust any nodes, parameters, or connections you'd like. When you're happy with it, come back and tell me to proceed.`,
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
        prompt: `Foliage zones submitted. The full scene workflow is complete:\n\n✓ Terrain generated in Gaea\n✓ Landscape imported into UE5\n✓ Placement zones ready for PCG\n\nYou can now use hayba_read_zones to feed the placement zones into PCG graphs, or call hayba_ue_landscape_pipeline again to start a new scene.`,
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
