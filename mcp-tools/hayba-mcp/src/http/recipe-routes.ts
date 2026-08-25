//
// Express router exposing the four recipe tools over HTTP. Used by the
// UE plugin's Recipes panel; the LLM-facing MCP tools (hayba_sliver_*)
// remain stdio-based via the MCP server. Both surfaces share the same
// RecipeSystem so installed recipes are visible from either side.

import type { Express, Request, Response } from 'express';
import type { RecipeSystem } from '../recipes/index.js';
import { recipeListHandler } from '../tools/recipe/list.js';
import { recipeGetHandler } from '../tools/recipe/get.js';
import { recipeRunHandler } from '../tools/recipe/run.js';
import { jsonObjectBody, stringQuery } from './express-boundary.js';

export function mountRecipeRoutes(app: Express, sys: RecipeSystem): void {
  app.get('/recipe/list', async (req: Request, res: Response) => {
    const category = stringQuery(req.query.category, 'category');
    const namespace = stringQuery(req.query.namespace, 'namespace');
    if (!category.ok) return void res.status(400).json({ error: category.error });
    if (!namespace.ok) return void res.status(400).json({ error: namespace.error });
    const r = await recipeListHandler(
      {
        category: category.value,
        namespace: namespace.value,
      },
      { loader: sys.loader },
    );
    res.json(r);
  });

  app.get('/recipe/get', async (req: Request, res: Response) => {
    const id = stringQuery(req.query.id, 'id');
    if (!id.ok) {
      res.status(400).json({ error: id.error });
      return;
    }
    if (!id.value) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await recipeGetHandler({ id: id.value }, { loader: sys.loader });
    res.json(r);
  });

  app.post('/recipe/run', async (req: Request, res: Response) => {
    const body = jsonObjectBody(req) as { id?: unknown; params?: unknown };
    if (typeof body.id !== 'string' || !body.id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const r = await recipeRunHandler(
      {
        id: body.id,
        params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>,
      },
      { runtime: sys.runtime },
    );
    res.json(r);
  });

  app.post('/recipe/import', async (req: Request, res: Response) => {
    const body = jsonObjectBody(req) as { spec?: unknown };
    if (!body.spec || typeof body.spec !== 'object') {
      res.status(400).json({ error: 'missing spec' });
      return;
    }
    const r = sys.loader.install(body.spec);
    res.json(r);
  });
}
