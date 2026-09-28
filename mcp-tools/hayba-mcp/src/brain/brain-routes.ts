// Localhost-only /brain/* routes the UE panel uses for Hayba Pro sign-in and
// status. Refresh tokens are held in memory by the connector; the panel stores
// them durably (DPAPI) and pushes them back on launch via POST /brain/config.

import type { Express, Request, Response } from 'express';
import { isLocalRequest } from '../http/loopback-guard.js';
import { jsonObjectBody } from '../http/express-boundary.js';
import type { BrainConnector } from './brain-connector.js';

/**
 * The only two responses that must carry a refresh token to the panel. The
 * dashboard app redacts every `res.json` body (token-named keys included), so
 * these are serialized directly; both routes are loopback-only.
 */
function sendTokenBearing(res: Response, body: Record<string, unknown>): Response {
  return res.type('application/json').send(JSON.stringify(body));
}

export { isLoopbackHostHeader, isLoopbackOrigin } from '../http/loopback-guard.js';

export function registerBrainRoutes(app: Express, connector: BrainConnector): void {
  // These routes hand out and accept a long-lived refresh token, so a loopback
  // peer address alone is not enough: a DNS-rebound page in the user's browser
  // also connects from 127.0.0.1. Require a loopback Host, and a loopback
  // Origin whenever a browser sends one.
  const local = (req: Request, res: Response) => {
    if (isLocalRequest(req)) return true;
    res.status(403).json({ error: 'brain routes are localhost-only' });
    return false;
  };
  app.post('/brain/signin/start', async (req, res) => {
    if (!local(req, res)) return;
    if (!connector.configured()) return res.status(503).json({ error: 'Hayba Pro is not configured' });
    try { return res.json(await connector.startSignin()); }
    catch { return res.status(502).json({ error: 'Hayba Pro is unreachable' }); }
  });
  app.post('/brain/signin/poll', async (req, res) => {
    if (!local(req, res)) return;
    const { device_code } = jsonObjectBody(req) as { device_code?: string };
    if (!device_code || typeof device_code !== 'string') return res.status(400).json({ error: 'device_code is required' });
    try {
      const r = await connector.pollSignin(device_code);
      if (r.status !== 'approved') return res.json({ status: r.status });
      connector.setRefreshToken(r.refresh_token, r.email);
      // refresh_token returned ONCE so the panel can DPAPI-store it; built
      // field-by-field so nothing else from the brain rides the redaction bypass.
      return sendTokenBearing(res, { status: 'approved', refresh_token: r.refresh_token, email: r.email });
    } catch { return res.status(502).json({ error: 'Hayba Pro is unreachable' }); }
  });
  app.post('/brain/config', (req, res) => {
    if (!local(req, res)) return;
    const { refresh_token, email } = jsonObjectBody(req) as { refresh_token?: string; email?: string };
    if (!refresh_token || typeof refresh_token !== 'string') return res.status(400).json({ error: 'refresh_token is required' });
    connector.setRefreshToken(refresh_token, typeof email === 'string' ? email : undefined);
    return res.json({ ok: true, signed_in: true });
  });
  app.get('/brain/status', (req, res) => {
    if (!local(req, res)) return;
    const s = connector.signedIn();
    const rotated = connector.takeRotatedRefreshToken();
    return sendTokenBearing(res, {
      configured: connector.configured(), signed_in: s.signedIn,
      ...(s.email ? { email: s.email } : {}),
      ...(rotated ? { rotated_refresh_token: rotated } : {}), // loopback-only; panel re-stores it in DPAPI
    });
  });
  app.post('/brain/signout', (req, res) => {
    if (!local(req, res)) return;
    connector.setRefreshToken(null);
    return res.json({ ok: true });
  });
}
