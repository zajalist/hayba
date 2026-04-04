import { Express, Request, Response } from 'express';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getUEClient } from '../tcp-client.js';
import { loadCatalog, searchCatalog, getCategories } from '../catalog.js';

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
}
