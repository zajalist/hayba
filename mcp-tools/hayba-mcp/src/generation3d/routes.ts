import express, { Router, type Express, type ErrorRequestHandler, type RequestHandler } from 'express';
import { isLocalRequest } from '../http/loopback-guard.js';
import { createGeneration3DClient, generation3DProviders, Generation3DError } from './client.js';

/** Keys are request-scoped; never persisted, logged, or included in response data. */
export function registerGeneration3DRoutes(app: Express, options: Parameters<typeof createGeneration3DClient>[0] = {}): void {
  const router = Router();
  const client = createGeneration3DClient(options);
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isLocalRequest(req)) { res.status(403).json({ error: { code: 'LOCAL_ONLY', message: 'This endpoint is available only to local callers.' } }); return; }
    if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: { code: 'JSON_REQUIRED', message: 'Content-Type must be application/json.' } }); return; }
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.get('/providers', (_req, res) => { res.json({ providers: generation3DProviders }); });
  const handle = (operation: (input: unknown) => Promise<unknown>): RequestHandler => async (req, res, next) => {
    try { res.json(await operation(req.body)); } catch (error) { next(error); }
  };
  router.post('/connection', handle(client.connection));
  router.post('/tasks', handle(client.create));
  router.post('/tasks/status', handle(client.status));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof Generation3DError) { res.status(error.httpStatus).json({ error: { code: error.code, message: error.message } }); return; }
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_INPUT', message: tooLarge ? 'The generation request is too large.' : 'Invalid generation request.' } });
  };
  router.use(errors);
  app.use(['/chat/generation', '/chat/3d'], router);
}
