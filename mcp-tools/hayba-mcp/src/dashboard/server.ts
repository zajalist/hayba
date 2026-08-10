import express from 'express';
import type { Server } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { registerApiRoutes } from './api.js';
import { installExpressJsonRedaction } from '../security/secret-redaction.js';
import { installHttpErrorBoundary } from '../http/express-boundary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DashboardAppOptions {
  /** Test/embedding seam. `null` deliberately disables static + SPA serving. */
  staticDir?: string | null;
  /** Test/embedding seam for registering routes before the reserved-prefix 404. */
  registerRoutes?: (app: express.Express) => void;
}

function detectStaticDir(): string | null {
  // Auto-detect: standalone (../../dashboard) or bundled (../../../dashboard).
  const candidates = [
    join(__dirname, '..', '..', 'dashboard', 'dist'),
    join(__dirname, '..', '..', 'dashboard'),
    join(__dirname, '..', '..', '..', 'dashboard', 'dist'),
    join(__dirname, '..', '..', '..', 'dashboard'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isSpaNavigation(path: string): boolean {
  if (extname(path) !== '') return false;
  return !path.split('/').some((segment) => segment.startsWith('.') && segment.length > 1);
}

/** Build the direct dashboard app without binding a socket. */
export function createDashboardApp(options: DashboardAppOptions = {}): express.Express {
  const app = express();
  // Pin Express 5 semantics instead of inheriting a future default change.
  app.set('query parser', 'simple');
  app.use(express.json({ limit: '50mb', strict: true }));
  installExpressJsonRedaction(app);

  (options.registerRoutes ?? registerApiRoutes)(app);

  // Once real routes have had their chance, reserved surfaces always stay JSON
  // 404s. They must never be mistaken for client-side dashboard navigation.
  app.use(['/api', '/chat', '/sliver'], (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const staticDir = options.staticDir === undefined ? detectStaticDir() : options.staticDir;
  if (staticDir && existsSync(staticDir)) {
    // Dotfiles remain deliberately unavailable. JS MIME is supplied by
    // Express 5's mime-db and pinned by the migration tests.
    app.use(express.static(staticDir, { dotfiles: 'ignore', fallthrough: true }));

    // Express 5 requires a named wildcard. Only extensionless HTML navigation
    // gets the SPA shell; missing assets and dot-paths remain genuine 404s.
    app.get('/{*splat}', (req, res, next) => {
      if (!isSpaNavigation(req.path) || !req.accepts('html')) return next();
      return res.sendFile(join(staticDir, 'index.html'));
    });
  }

  installHttpErrorBoundary(app);
  return app;
}

/** Start the dashboard, returning a closeable server or null after bind failure. */
export async function startDashboard(
  port: number,
  host: string,
  options: DashboardAppOptions = {},
): Promise<Server | null> {
  const app = createDashboardApp(options);

  return new Promise((resolve) => {
    const server = app.listen(port, host, (error?: Error) => {
      if (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'EADDRINUSE') {
          console.error(`Dashboard port ${port} already in use — dashboard HTTP skipped, MCP stdio still active`);
        } else {
          console.error(`Dashboard server error: ${err.message}`);
        }
        resolve(null);
        return;
      }
      console.error(`Dashboard listening at http://${host}:${port}`);
      resolve(server);
    });
  });
}
