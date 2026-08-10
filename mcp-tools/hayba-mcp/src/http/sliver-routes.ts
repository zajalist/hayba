//
// Express router exposing the four sliver tools over HTTP. Used by the
// UE plugin's Slivers panel; the LLM-facing MCP tools (hayba_sliver_*)
// remain stdio-based via the MCP server. Both surfaces share the same
// SliverSystem so installed slivers are visible from either side.

import type { Express, Request, Response } from 'express';
import type { SliverSystem } from '../slivers/index.js';
import { sliverListHandler } from '../tools/sliver/list.js';
import { sliverGetHandler } from '../tools/sliver/get.js';
import { sliverRunHandler } from '../tools/sliver/run.js';
import { jsonObjectBody, stringQuery } from './express-boundary.js';

export function mountSliverRoutes(app: Express, sys: SliverSystem): void {
  app.get('/sliver/list', async (req: Request, res: Response) => {
    const category = stringQuery(req.query.category, 'category');
    const namespace = stringQuery(req.query.namespace, 'namespace');
    if (!category.ok) return void res.status(400).json({ error: category.error });
    if (!namespace.ok) return void res.status(400).json({ error: namespace.error });
    const r = await sliverListHandler(
      {
        category: category.value,
        namespace: namespace.value,
      },
      { loader: sys.loader },
    );
    res.json(r);
  });

  app.get('/sliver/get', async (req: Request, res: Response) => {
    const id = stringQuery(req.query.id, 'id');
    if (!id.ok) {
      res.status(400).json({ error: id.error });
      return;
    }
    if (!id.value) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await sliverGetHandler({ id: id.value }, { loader: sys.loader });
    res.json(r);
  });

  app.post('/sliver/run', async (req: Request, res: Response) => {
    const body = jsonObjectBody(req) as { id?: unknown; params?: unknown };
    if (typeof body.id !== 'string' || !body.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await sliverRunHandler(
      {
        id: body.id,
        params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>,
      },
      { runtime: sys.runtime },
    );
    res.json(r);
  });

  app.post('/sliver/import', async (req: Request, res: Response) => {
    const body = jsonObjectBody(req) as { spec?: unknown };
    if (!body.spec || typeof body.spec !== 'object') {
      res.status(400).json({ error: 'missing spec' });
      return;
    }
    const r = sys.loader.install(body.spec);
    res.json(r);
  });
}
