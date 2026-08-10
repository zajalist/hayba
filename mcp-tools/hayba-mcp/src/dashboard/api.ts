import { Express, Request, Response } from 'express';
import { config } from '../config.js';
import { getUEClient } from '../tcp-client.js';
import { loadCatalog, searchCatalog, getCategories } from '../catalog.js';
import { createProject, deleteProject, getProject, listProjects } from '../projects.js';
import {
  submitZones,
  getCurrentZones,
  setHeightmap,
  getHeightmap,
  getPainterSession,
  lockPainter,
  unlockPainter,
  createScratchSession,
  submitScratchZones,
  getScratchZones,
} from '../zones.js';
import { getEntries, addEntry, deleteEntry, getBaseTemplates } from '../encyclopedia.js';
import type { EncyclopediaEntry } from '../encyclopedia.js';
import { getCachedSidecarHealth, pingSidecar } from '../tools/visual/sidecar-client.js';
import { registerChatRoutes } from '../chat/chat-server.js';
import { jsonObjectBody, stringQuery } from '../http/express-boundary.js';

/**
 * Register REST API endpoints for the dashboard.
 */
export function registerApiRoutes(app: Express): void {
  // BYOK copilot SSE surface (Task 4) — /chat/stream, /chat/cancel,
  // /chat/approve, /chat/config. Localhost-only, key never persisted/echoed.
  registerChatRoutes(app);

  // Server health
  app.get('/api/health', (_req: Request, res: Response) => {
    const client = getUEClient();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      nodeVersion: process.version,
      port: config.dashboardPort,
      ueConnected: client.isConnected(),
      ueTcpTarget: `${config.ueTcpHost}:${config.ueTcpPort}`,
    });
  });

  // Node catalog search
  app.get('/api/catalog/search', (req: Request, res: Response) => {
    const parsed = stringQuery(req.query.q, 'q');
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const query = parsed.value ?? '';
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter: q' });
    }
    const results = searchCatalog(query);
    res.json({ results, count: results.length });
  });

  // Node catalog categories
  app.get('/api/catalog/categories', (_req: Request, res: Response) => {
    res.json({ categories: getCategories() });
  });

  // Full catalog
  app.get('/api/catalog', (_req: Request, res: Response) => {
    try {
      const catalog = loadCatalog();
      res.json(catalog);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load catalog' });
    }
  });

  // UE status (ping) + visual sidecar handshake
  app.get('/api/ue/status', async (_req: Request, res: Response) => {
    const sidecar = getCachedSidecarHealth() ?? (await pingSidecar());
    const sidecarFields = {
      visual_embeddings_available: sidecar.available,
      active_models: sidecar.active_models,
      sidecar_url: sidecar.url,
      sidecar_error: sidecar.error,
    };
    try {
      const client = getUEClient();
      if (!client.isConnected()) {
        return res.json({ connected: false, error: 'Not connected to UE', ...sidecarFields });
      }
      const response = await client.send('ping', {}, 5000);
      if (response.ok) {
        res.json({ connected: true, ...sidecarFields, ...response.data });
      } else {
        res.json({ connected: false, error: response.error, ...sidecarFields });
      }
    } catch (err) {
      res.json({ connected: false, error: err instanceof Error ? err.message : 'Unknown error', ...sidecarFields });
    }
  });

  // Force a fresh sidecar probe (useful after launching the sidecar mid-session)
  app.post('/api/sidecar/refresh', async (_req: Request, res: Response) => {
    try {
      const health = await pingSidecar();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // List PCG assets
  app.get('/api/ue/assets', async (req: Request, res: Response) => {
    try {
      const client = getUEClient();
      const parsed = stringQuery(req.query.path, 'path');
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const path = parsed.value || '/Game/';
      const response = await client.send('list_pcg_assets', { path });
      if (response.ok) {
        res.json(response.data);
      } else {
        res.status(500).json({ error: response.error });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // ── Projects ──────────────────────────────────────────────────────────────

  app.post('/api/projects', async (req: Request, res: Response) => {
    const { name } = jsonObjectBody(req) as { name?: unknown };
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    const project = await createProject(name);
    res.json(project);
  });

  app.get('/api/projects', async (_req: Request, res: Response) => {
    const projects = await listProjects();
    res.json(projects);
  });

  app.get('/api/projects/:projectId', async (req: Request, res: Response) => {
    const project = await getProject(req.params.projectId as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  app.delete('/api/projects/:projectId', async (req: Request, res: Response) => {
    const deleted = await deleteProject(req.params.projectId as string);
    if (!deleted) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  // ── Zones ─────────────────────────────────────────────────────────────────

  app.post('/api/zones/submit', async (req: Request, res: Response) => {
    const { projectId, zones, masks, canvasSize, phase } = jsonObjectBody(req) as {
      projectId?: string;
      zones?: unknown[];
      masks?: { zoneId: string; pngBase64: string }[];
      canvasSize?: 1024 | 2048 | 4096;
      phase?: 'a' | 'b';
    };
    if (!projectId || !zones || !masks)
      return res.status(400).json({ error: 'projectId, zones, and masks are required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const session = await submitZones(
      projectId,
      zones as Parameters<typeof submitZones>[1],
      masks,
      undefined,
      canvasSize,
      phase,
    );
    res.json(session);
  });

  app.get('/api/zones/current/:projectId', async (req: Request, res: Response) => {
    const session = await getCurrentZones(req.params.projectId as string);
    if (!session) return res.status(404).json({ error: 'No zone submission found' });
    res.json(session);
  });

  app.post('/api/zones/heightmap', async (req: Request, res: Response) => {
    const { projectId, heightmapPath } = jsonObjectBody(req) as { projectId?: string; heightmapPath?: string };
    if (!projectId || !heightmapPath)
      return res.status(400).json({ error: 'projectId and heightmapPath are required' });
    await setHeightmap(projectId, heightmapPath);
    res.json({ ok: true });
  });

  app.get('/api/zones/heightmap/:projectId', async (req: Request, res: Response) => {
    const path = await getHeightmap(req.params.projectId as string);
    res.json({ heightmapPath: path });
  });

  // ── Painter session (lock/unlock) ─────────────────────────────────────────

  app.get('/api/zones/painter-session', (_req: Request, res: Response) => {
    res.json(getPainterSession() ?? { unlocked: false });
  });

  app.post('/api/zones/painter-session', (req: Request, res: Response) => {
    const { projectId, phase } = jsonObjectBody(req) as { projectId?: string; phase?: 'a' | 'b' };
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    unlockPainter(projectId, phase ?? 'a');
    res.json({ ok: true });
  });

  app.delete('/api/zones/painter-session', (_req: Request, res: Response) => {
    lockPainter();
    res.json({ ok: true });
  });

  // ── Scratch sessions ───────────────────────────────────────────────────────

  app.post('/api/zones/scratch-session', (_req: Request, res: Response) => {
    const result = createScratchSession();
    unlockPainter(`scratch:${result.scratchSessionId}`, 'a');
    res.json(result);
  });

  app.post('/api/zones/scratch-submit', async (req: Request, res: Response) => {
    const { scratchSessionId, zones, masks, canvasSize } = jsonObjectBody(req) as {
      scratchSessionId?: string;
      zones?: Omit<Parameters<typeof submitScratchZones>[1][0], never>[];
      masks?: { zoneId: string; pngBase64: string }[];
      canvasSize?: 1024 | 2048 | 4096;
    };
    if (!scratchSessionId || !zones || !masks) {
      return res.status(400).json({ error: 'scratchSessionId, zones, and masks are required' });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await submitScratchZones(scratchSessionId, zones as any, masks, undefined, canvasSize);
    res.json(session);
  });

  app.get('/api/zones/scratch/:scratchSessionId', async (req: Request, res: Response) => {
    const session = await getScratchZones(req.params.scratchSessionId as string);
    if (!session) return res.status(404).json({ error: 'No zone submission found for scratch session' });
    res.json(session);
  });

  // ── Encyclopedia ──────────────────────────────────────────────────────────

  app.get('/api/encyclopedia/templates', (_req: Request, res: Response) => {
    res.json(getBaseTemplates());
  });

  app.get('/api/encyclopedia/:projectId', async (req: Request, res: Response) => {
    const entries = await getEntries(req.params.projectId as string);
    res.json(entries);
  });

  app.post('/api/encyclopedia/:projectId', async (req: Request, res: Response) => {
    const entry = jsonObjectBody(req) as Partial<EncyclopediaEntry>;
    if (!entry?.id || !entry?.name) return res.status(400).json({ error: 'id and name are required' });
    await addEntry(req.params.projectId as string, entry as EncyclopediaEntry);
    res.json({ ok: true });
  });

  app.delete('/api/encyclopedia/:projectId/:entryId', async (req: Request, res: Response) => {
    await deleteEntry(req.params.projectId as string, req.params.entryId as string);
    res.json({ ok: true });
  });
}
