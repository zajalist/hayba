import { createRequire } from 'node:module';

/**
 * The hayba-mcp package version, read from package.json so the MCP serverInfo
 * and the Pro brain handshake (`client_version`) report the same value.
 * Resolves identically from `src/` (tests) and `dist/` (built server).
 */
export const HAYBA_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
