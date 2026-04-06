/**
 * Log a message to stderr (MCP stdio uses stdout, so logs go to stderr).
 */
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  console.error(line);
}
