/**
 * Log a message to stderr (MCP stdio uses stdout, so logs go to stderr).
 */
import { redactSecrets } from './security/secret-redaction.js';

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${redactSecrets(message).value}`;
  console.error(line);
}
