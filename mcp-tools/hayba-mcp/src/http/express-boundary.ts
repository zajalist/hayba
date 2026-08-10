import type { ErrorRequestHandler, Express, Request } from 'express';
import { redactThrown } from '../security/secret-redaction.js';

/**
 * Express 5 deliberately leaves `req.body` undefined when no parser produced a
 * value. HTTP handlers should still be able to validate an absent body as an
 * empty input object instead of throwing while destructuring it.
 */
export function jsonObjectBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export type StringQueryResult = { ok: true; value: string | undefined } | { ok: false; error: string };

/**
 * Read one string query value without silently accepting duplicate parameters.
 * Express 5's simple parser represents `?x=a&x=b` as an array. Treating that as
 * a scalar is endpoint-dependent and has caused parameter-pollution bypasses in
 * other HTTP applications, so Hayba rejects the ambiguous form consistently.
 */
export function stringQuery(value: unknown, name: string): StringQueryResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false, error: `query parameter '${name}' must appear exactly once` };
}

/**
 * Keep parser and async-handler failures on the JSON boundary. In particular,
 * malformed request text must never fall through to the SPA or Express's HTML
 * error page, and exception messages are not reflected to the caller.
 */
export function installHttpErrorBoundary(app: Express): void {
  const boundary: ErrorRequestHandler = (error, _req, res, next) => {
    const safeError = redactThrown(error);
    if (res.headersSent) {
      // Express's final handler owns the only safe action after bytes are on the
      // wire: close the connection. Forward a redacted Error so even its
      // diagnostic path cannot receive the original secret-bearing message.
      next(safeError);
      return;
    }

    const candidate = error as { status?: unknown; type?: unknown };
    if (candidate?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body must be one valid JSON object' });
      return;
    }
    if (candidate?.type === 'entity.too.large') {
      res.status(413).json({ error: "JSON body exceeds this endpoint's configured limit" });
      return;
    }

    console.error('Hayba HTTP request failed', safeError);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(boundary);
}
