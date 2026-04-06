import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SessionManager } from "./session.js";
import { getToolDefinitions, dispatchTool } from "./tools/index.js";
import { detectGaeaPath } from "./gaea-launcher.js";

// Import all tools so they self-register
import "./tools/list-node-types.js";
import "./tools/create-terrain.js";
import "./tools/get-graph-state.js";
import "./tools/get-parameters.js";
import "./tools/set-parameter.js";
import "./tools/cook-graph.js";
import "./tools/open-session.js";
import "./tools/add-node.js";
import "./tools/connect-nodes.js";
import "./tools/remove-node.js";
import "./tools/close-session.js";
import "./tools/bake-terrain.js";
import "./tools/read-terrain-variables.js";
import "./tools/set-terrain-variables.js";
import "./tools/open-in-gaea.js";

// Load config from swarmhost.config.json (update execPath to point at Gaea.BuildManager.exe)
const configPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "swarmhost.config.json"
);
const config = JSON.parse(readFileSync(configPath, "utf-8").replace(/^\uFEFF/, ""));

// Auto-detect gaeaExePath if not in config
if (!config.gaeaExePath) {
  const detected = detectGaeaPath();
  if (detected) config.gaeaExePath = detected;
}

const session = new SessionManager(config);

const server = new Server(
  { name: "hayba-gaea", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions()
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await dispatchTool(
    request.params.name,
    (request.params.arguments ?? {}) as Record<string, unknown>,
    session
  );
  return result as CallToolResult;
});

const transport = new StdioServerTransport();
await server.connect(transport);
