// Shared MCP tool types. Decoupled from any gaea-flavored handler file so the
// rest of the tool tree builds without the terrain stack present.

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// SessionManager is a typed shim while the terrain stack is parked. Handlers
// that don't touch terrain accept it without using it. Gaea handlers (which
// import the real class directly) live behind the .gitignore and only the
// maintainer needs the full surface.
export type SessionManager = Record<string, unknown>;

export type ToolHandler = (args: Record<string, unknown>, session: SessionManager) => Promise<ToolResult>;
