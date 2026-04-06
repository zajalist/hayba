// mcp_server/src/config.ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  /** UE TCP server port */
  ueTcpPort: parseInt(process.env.UE_TCP_PORT || '52342', 10),

  /** UE TCP server host */
  ueTcpHost: process.env.UE_TCP_HOST || '127.0.0.1',

  /** Web dashboard port */
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '52341', 10),

  /** Dashboard host */
  dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',

  /** Path to node catalog */
  get catalogPath() {
    return resolve(__dirname, '..', '..', 'Resources', 'node_catalog.json');
  },
};
