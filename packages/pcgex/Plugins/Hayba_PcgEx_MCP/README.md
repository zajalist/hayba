# PCGEx Bridge — UE5 Plugin

## Installation

1. Copy this `PCGExBridge` folder to your UE5 project's `Plugins/` directory
2. Install Node.js 20+ on your system (or bundle it in `ThirdParty/node/`)
3. Build the MCP server:
   ```bash
   cd Plugins/PCGExBridge/ThirdParty/mcp_server
   npm install
   npm run build
   ```
4. Restart UE5

## Usage

1. Open UE5 editor
2. Go to Window → PCGEx Bridge to open the panel
3. Click **Start MCP** to launch the server
4. Click **Open Dashboard** to open the web UI
5. Click **Run Exporter** to extract existing PCG graphs

## Directory Structure

```
PCGExBridge/
├── Bridge/
│   ├── pcgex_context/   ← Extracted graphs (JSON)
│   ├── bridge_inbox/    ← Submitted graphs awaiting ingestion
│   └── bridge_outbox/   ← Ingestion status files
├── Content/Python/      ← UE Python scripts
├── ThirdParty/mcp_server/ ← Node.js MCP server
└── Source/              ← C++ plugin code
```
