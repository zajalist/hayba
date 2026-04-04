import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>, session: SessionManager) => Promise<ToolResult>;

const toolHandlers = new Map<string, ToolHandler>();
const toolDefinitions: Tool[] = [];

export function registerTool(definition: Tool, handler: ToolHandler): void {
  toolDefinitions.push(definition);
  toolHandlers.set(definition.name, handler);
}

export function getToolDefinitions(): Tool[] {
  return toolDefinitions;
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  session: SessionManager
): Promise<ToolResult> {
  const handler = toolHandlers.get(name);
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    return await handler(args, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Tool error: ${message}` }], isError: true };
  }
}
