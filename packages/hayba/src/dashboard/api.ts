import { Express, Request, Response } from 'express';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getUEClient } from '../tcp-client.js';
import { loadCatalog, searchCatalog, getCategories } from '../catalog.js';
import { createProject, getProject, listProjects } from '../projects.js';
import { submitZones, getCurrentZones, setHeightmap, getHeightmap } from '../zones.js';
import { getEntries, addEntry, deleteEntry, getBaseTemplates } from '../encyclopedia.js';

/**
 * Register REST API endpoints for the dashboard.
 */
export function registerApiRoutes(app: Express): void {
  // Server health
  app.get('/api/health', (_req: Request, res: Response) => {
    const client = getUEClient();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      nodeVersion: process.version,
      port: config.dashboardPort,
      ueConnected: client.isConnected(),
      ueTcpTarget: `${config.ueTcpHost}:${config.ueTcpPort}`
    });
  });

  // Node catalog search
  app.get('/api/catalog/search', (req: Request, res: Response) => {
    const query = (req.query.q as string) || '';
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

  // UE status (ping)
  app.get('/api/ue/status', async (_req: Request, res: Response) => {
    try {
      const client = getUEClient();
      if (!client.isConnected()) {
        return res.json({ connected: false, error: 'Not connected to UE' });
      }
      const response = await client.send('ping', {}, 5000);
      if (response.ok) {
        res.json({ connected: true, ...response.data });
      } else {
        res.json({ connected: false, error: response.error });
      }
    } catch (err) {
      res.json({ connected: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  // List PCG assets
  app.get('/api/ue/assets', async (req: Request, res: Response) => {
    try {
      const client = getUEClient();
      const path = (req.query.path as string) || '/Game/';
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
    const { name } = req.body as { name?: string };
    if (!name) return res.status(400).json({ error: 'name is required' });
    const project = await createProject(name);
    res.json(project);
  });

  app.get('/api/projects', async (_req: Request, res: Response) => {
    const projects = await listProjects();
    res.json(projects);
  });

  app.get('/api/projects/:projectId', async (req: Request, res: Response) => {
    const project = await getProject(req.params['projectId'] as string);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  });

  // ── Zones ─────────────────────────────────────────────────────────────────

  app.post('/api/zones/submit', async (req: Request, res: Response) => {
    const { projectId, zones, masks, canvasSize, phase } = req.body as {
      projectId?: string;
      zones?: unknown[];
      masks?: { zoneId: string; pngBase64: string }[];
      canvasSize?: 1024 | 2048 | 4096;
      phase?: 'a' | 'b';
    };
    if (!projectId || !zones || !masks) return res.status(400).json({ error: 'projectId, zones, and masks are required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const session = await submitZones(projectId, zones as any, masks, undefined, canvasSize, phase);
    res.json(session);
  });

  app.get('/api/zones/current/:projectId', async (req: Request, res: Response) => {
    const session = await getCurrentZones(req.params['projectId'] as string);
    if (!session) return res.status(404).json({ error: 'No zone submission found' });
    res.json(session);
  });

  app.post('/api/zones/heightmap', async (req: Request, res: Response) => {
    const { projectId, heightmapPath } = req.body as { projectId?: string; heightmapPath?: string };
    if (!projectId || !heightmapPath) return res.status(400).json({ error: 'projectId and heightmapPath are required' });
    await setHeightmap(projectId, heightmapPath);
    res.json({ ok: true });
  });

  app.get('/api/zones/heightmap/:projectId', async (req: Request, res: Response) => {
    const path = await getHeightmap(req.params['projectId'] as string);
    res.json({ heightmapPath: path });
  });

  // ── Encyclopedia ──────────────────────────────────────────────────────────

  app.get('/api/encyclopedia/templates', (_req: Request, res: Response) => {
    res.json(getBaseTemplates());
  });

  app.get('/api/encyclopedia/:projectId', async (req: Request, res: Response) => {
    const entries = await getEntries(req.params['projectId'] as string);
    res.json(entries);
  });

  app.post('/api/encyclopedia/:projectId', async (req: Request, res: Response) => {
    const entry = req.body;
    if (!entry?.id || !entry?.name) return res.status(400).json({ error: 'id and name are required' });
    await addEntry(req.params['projectId'] as string, entry);
    res.json({ ok: true });
  });

  app.delete('/api/encyclopedia/:projectId/:entryId', async (req: Request, res: Response) => {
    await deleteEntry(req.params['projectId'] as string, req.params['entryId'] as string);
    res.json({ ok: true });
  });
}
