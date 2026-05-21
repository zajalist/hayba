//
// Bootstraps a minimal Express HTTP server alongside the MCP stdio server.
// Used by the UE plugin's Slivers panel to call sliver list/get/run/import
// without going through the MCP transport. Logs go to stderr so they don't
// corrupt the MCP stdio (stdout) channel.
//
// Binds to 127.0.0.1 only — never expose to the network.

import express from 'express';
import type { Server } from 'node:http';
import type { SliverSystem } from '../slivers/index.js';
import { mountSliverRoutes } from './sliver-routes.js';

export function startHttpServer(slivers: SliverSystem): Server {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  mountSliverRoutes(app, slivers);

  const port = Number(process.env.HAYBA_MCP_HTTP_PORT ?? 3091);
  const host = '127.0.0.1';

  const server = app.listen(port, host, () => {
    console.error(`Hayba HTTP server listening on http://${host}:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Hayba HTTP server error: ${err.code ?? ''} ${err.message}`);
  });

  return server;
}
