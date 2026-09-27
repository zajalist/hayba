// Loopback request guard shared by the sidecar's local-only HTTP routes
// (/chat/*, /brain/*). A loopback peer address alone is not enough: a
// DNS-rebound page in the user's browser also connects from 127.0.0.1, so the
// `Host` must name a loopback host and a browser `Origin`, when sent, must be a
// loopback origin too.

import type { Request } from 'express';

/** True for IPv4/IPv6 loopback (incl. IPv4-mapped IPv6). Never network-exposed. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `Host` must name a loopback host (any port): a rebound DNS name is refused. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(\[::1\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return match !== null && LOOPBACK_HOSTNAMES.has(match[1]);
}

/** A browser `Origin`, when present, must itself be a loopback http(s) origin. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false; // includes the opaque "null" origin
  }
}

/** Loopback peer + loopback Host + (absent or loopback) Origin. */
export function isLocalRequest(req: Pick<Request, 'socket' | 'headers'>): boolean {
  const origin = req.headers.origin;
  return isLoopback(req.socket.remoteAddress) &&
    isLoopbackHostHeader(req.headers.host) &&
    (origin === undefined || isLoopbackOrigin(origin));
}
