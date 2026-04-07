import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { registerApiRoutes } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the Express dashboard server.
 */
export async function startDashboard(port: number, host: string): Promise<void> {
  const app = express();
  app.use(express.json());

  // Register API routes for dashboard data
  registerApiRoutes(app);

  // Serve static files from the dashboard directory
  // Auto-detect: standalone (../../dashboard) or bundled (../../../dashboard)
  let staticDir = join(__dirname, '..', '..', 'dashboard', 'dist');
  if (!existsSync(staticDir)) {
    staticDir = join(__dirname, '..', '..', 'dashboard');
  }
  if (!existsSync(staticDir)) {
    staticDir = join(__dirname, '..', '..', '..', 'dashboard', 'dist');
  }
  if (!existsSync(staticDir)) {
    staticDir = join(__dirname, '..', '..', 'dashboard');
  }
  if (!existsSync(staticDir)) {
    staticDir = join(__dirname, '..', '..', '..', 'dashboard', 'dist');
  }
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));

    // Catch-all: serve index.html for any non-API route (SPA behavior)
    app.get('*', (_req: express.Request, res: express.Response) => {
      res.sendFile(join(staticDir, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.error(`Dashboard listening at http://${host}:${port}`);
      resolve();
    });
    server.on('error', reject);
  });
}
