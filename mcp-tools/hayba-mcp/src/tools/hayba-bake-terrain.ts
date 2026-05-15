// Stub — hayba-bake-terrain was removed from the active MCP surface.
// Retained here so visual tool handlers that import ToolHandler still compile.

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
