import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Request, Response } from 'express';
import express from 'express';
import { isLocalRequest } from '../http/loopback-guard.js';
import { jsonObjectBody } from '../http/express-boundary.js';
import { WorkspaceHost, createHttpChatClient } from './workspace-host.js';

const here = dirname(fileURLToPath(import.meta.url));

export function detectChatResources(): string | null {
  if (process.env.HAYBA_CHAT_UI && existsSync(join(process.env.HAYBA_CHAT_UI, 'chat', 'index.html'))) {
    return resolve(process.env.HAYBA_CHAT_UI);
  }
  const candidates = [
    join(here, '../../../Resources'),
    join(here, '../../../../Resources'),
    join(here, '../../../../../unreal/HaybaMCPToolkit/Resources'),
    join(process.cwd(), 'Plugins/HaybaMCPToolkit/Resources'),
    join(process.cwd(), 'unreal/HaybaMCPToolkit/Resources'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'chat', 'index.html'))) ?? null;
}

function requireLoopback(req: Request, res: Response): boolean {
  if (isLocalRequest(req)) return true;
  res.status(403).json({ error: 'Hayba app routes are localhost-only' });
  return false;
}

export function registerWorkspaceRoutes(
  app: Express,
  options: { host?: WorkspaceHost; resources?: string | null; chatBase?: () => string } = {},
): WorkspaceHost {
  const resources = options.resources === undefined ? detectChatResources() : options.resources;
  const host =
    options.host ??
    new WorkspaceHost(createHttpChatClient(options.chatBase?.() || `http://127.0.0.1:${process.env.DASHBOARD_PORT || '7821'}`));

  app.post('/workspace/event', async (req, res) => {
    if (!requireLoopback(req, res)) return;
    const snapshot = await host.handle(jsonObjectBody(req));
    res.json({ snapshot });
  });
  app.get('/workspace/snapshot', (req, res) => {
    if (!requireLoopback(req, res)) return;
    res.json(host.snapshot());
  });
  app.get('/workspace/health', (req, res) => {
    if (!requireLoopback(req, res)) return;
    res.json({ ok: true, service: 'hayba-app', resources: Boolean(resources) });
  });

  if (resources && existsSync(join(resources, 'chat', 'index.html'))) {
    app.get('/', (req, res) => {
      if (!requireLoopback(req, res)) return;
      res.redirect(302, '/app/chat/');
    });
    app.get(['/app/chat', '/app/chat/'], (req, res, next) => {
      if (!requireLoopback(req, res)) return;
      try {
        let html = readFileSync(join(resources, 'chat', 'index.html'), 'utf8');
        html = html.replace("connect-src 'none'", "connect-src 'self'");
        html = html.replace('<body>', '<body data-hayba-host="app">');
        res.type('html').send(html);
      } catch (error) {
        next(error);
      }
    });
    app.use('/app', express.static(resources, { dotfiles: 'ignore', index: false }));
  }
  return host;
}
