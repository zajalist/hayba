// Sidecar-side handle on the hosted Hayba Pro brain: device-code sign-in,
// in-memory refresh/access tokens, and opening authenticated BrainSessions.
// Tokens are held in memory only; the panel owns durable (DPAPI) storage.

import type { LlmMode, Permissions, ToolManifestEntry } from '@hayba/brain-protocol';
import { BrainSession, type SocketFactory } from './brain-session.js';

export type DeviceStart = { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };
export type DevicePoll = { status: 'pending' } | { status: 'expired' } | { status: 'approved'; refresh_token: string; email: string };

export interface BrainConnector {
  configured(): boolean;
  signedIn(): { signedIn: boolean; email?: string };
  /** The newest rotated refresh token, returned once (then null) so the panel can re-store it. */
  takeRotatedRefreshToken(): string | null;
  setRefreshToken(token: string | null, email?: string): void;
  startSignin(): Promise<DeviceStart>;
  pollSignin(deviceCode: string): Promise<DevicePoll>;
  openSession(
    sessionId: string, llm: LlmMode, manifest: ToolManifestEntry[], permissions: Permissions,
  ): Promise<{ ok: true; session: BrainSession } | { ok: false; reason: string; message: string }>;
}

export function createBrainConnector(opts: {
  brainUrl: string; clientVersion: string; fetchImpl?: typeof fetch; socketFactory?: SocketFactory;
}): BrainConnector {
  const doFetch = opts.fetchImpl ?? fetch;
  const http = opts.brainUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '');
  let refreshToken: string | null = null;
  let email: string | undefined;
  let access: { token: string; expiresAt: number } | null = null;
  /** Supabase rotates refresh tokens; the panel must re-store the new one or the next editor launch can't sign in. */
  let rotated: string | null = null;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(`${http}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`brain ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async function getAccessToken(): Promise<string> {
    if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
    if (!refreshToken) throw new Error('not signed in to Hayba Pro');
    const t = await post<{ access_token: string; refresh_token: string; expires_in: number }>('/auth/refresh', { refresh_token: refreshToken });
    if (t.refresh_token !== refreshToken) rotated = t.refresh_token;
    refreshToken = t.refresh_token;
    access = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return access.token;
  }

  return {
    configured: () => opts.brainUrl.length > 0,
    signedIn: () => ({ signedIn: refreshToken !== null, email }),
    takeRotatedRefreshToken() { const r = rotated; rotated = null; return r; },
    setRefreshToken(token, mail) { refreshToken = token; rotated = null; email = token ? mail ?? email : undefined; access = null; },
    startSignin: () => post<DeviceStart>('/device/start', {}),
    pollSignin: (deviceCode) => post<DevicePoll>('/device/poll', { device_code: deviceCode }),
    async openSession(sessionId, llm, manifest, permissions) {
      if (!opts.brainUrl) return { ok: false, reason: 'not_configured', message: 'Hayba Pro is not configured on this machine.' };
      if (!refreshToken) return { ok: false, reason: 'auth', message: 'Sign in to Hayba Pro in Settings first.' };
      let session: BrainSession;
      try {
        session = new BrainSession(sessionId, {
          url: `${opts.brainUrl.replace(/\/$/, '')}/v1/session`,
          clientVersion: opts.clientVersion,
          getAccessToken,
          hello: { manifest, permissions, llm },
          socketFactory: opts.socketFactory,
        });
        const r = await session.open();
        return r.ok ? { ok: true, session } : { ok: false, reason: r.reason, message: r.message };
      } catch (err) {
        return { ok: false, reason: 'unreachable', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
