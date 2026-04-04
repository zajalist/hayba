#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { execSync, spawnSync } from "child_process";
import { homedir, platform } from "os";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) =>
  new Promise((resolve) => {
    rl.question(prompt, resolve);
  });

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const OS = platform();
const IS_WIN = OS === "win32";
const HOME = homedir();

const COLORS = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function log(color, ...args) {
  console.log(`${COLORS[color]}${args.join(" ")}${COLORS.reset}`);
}

function checkNodeVersion() {
  try {
    const version = execSync("node --version", {
      encoding: "utf-8",
    })
      .trim()
      .substring(1);
    const major = parseInt(version.split(".")[0], 10);
    if (major < 20) {
      throw new Error(`Node.js 20+ required. Found: ${version}`);
    }
    log("green", `[OK] Node.js ${version}`);
    return true;
  } catch (e) {
    log("red", "Node.js 20+ is required. Download from https://nodejs.org");
    process.exit(1);
  }
}

function detectGaea() {
  if (!IS_WIN) {
    log(
      "yellow",
      "[NOTE] Gaea is Windows-only. Skipping Gaea detection on this platform."
    );
    return null;
  }

  const candidates = [
    path.join(
      process.env.LOCALAPPDATA,
      "Programs\\Gaea 2.0\\Gaea.exe"
    ),
    path.join(process.env.LOCALAPPDATA, "Programs\\Gaea 2.2\\Gaea.exe"),
    path.join(process.env.LOCALAPPDATA, "Programs\\Gaea\\Gaea.exe"),
    "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.exe",
  ];

  const found = candidates.find((p) => fs.existsSync(p));
  if (found) {
    log("green", `[OK] Gaea found: ${found}`);
    return found;
  }

  log("yellow", "[WARN] Gaea.exe not found. Sessions will not launch Gaea.");
  return null;
}

function findBuildManager(gaeaExePath) {
  if (!gaeaExePath) return null;
  const dir = path.dirname(gaeaExePath);
  const buildManager = path.join(dir, "Gaea.BuildManager.exe");
  if (fs.existsSync(buildManager)) {
    return buildManager;
  }
  return null;
}

function detectMcpClients() {
  const clients = [];

  // Claude Desktop
  if (IS_WIN) {
    const claudeDesktopConfig = path.join(
      process.env.APPDATA,
      "Claude\\claude_desktop_config.json"
    );
    if (fs.existsSync(claudeDesktopConfig)) {
      clients.push({
        name: "Claude Desktop",
        configPath: claudeDesktopConfig,
        type: "claude-desktop",
      });
    }
  } else {
    const macClaudeConfig = path.join(
      HOME,
      "Library/Application Support/Claude/claude_desktop_config.json"
    );
    const linuxClaudeConfig = path.join(HOME, ".config/Claude/claude_desktop_config.json");
    if (fs.existsSync(macClaudeConfig)) {
      clients.push({
        name: "Claude Desktop",
        configPath: macClaudeConfig,
        type: "claude-desktop",
      });
    } else if (fs.existsSync(linuxClaudeConfig)) {
      clients.push({
        name: "Claude Desktop",
        configPath: linuxClaudeConfig,
        type: "claude-desktop",
      });
    }
  }

  // Cursor
  const cursorConfig = path.join(HOME, ".cursor/mcp.json");
  if (fs.existsSync(cursorConfig)) {
    clients.push({
      name: "Cursor",
      configPath: cursorConfig,
      type: "cursor",
    });
  }

  // Continue.dev
  const continueConfig = path.join(HOME, ".continue/config.json");
  if (fs.existsSync(continueConfig)) {
    clients.push({
      name: "Continue.dev",
      configPath: continueConfig,
      type: "continue",
    });
  }

  // OpenCode (if VSCode is detected)
  const vscodeSettings = path.join(
    IS_WIN
      ? path.join(process.env.APPDATA, "Code/User/settings.json")
      : OS === "darwin"
        ? path.join(HOME, "Library/Application Support/Code/User/settings.json")
        : path.join(HOME, ".config/Code/User/settings.json")
  );
  if (fs.existsSync(vscodeSettings)) {
    clients.push({
      name: "VS Code / Cline / Continue",
      configPath: vscodeSettings,
      type: "vscode",
    });
  }

  return clients;
}

async function selectMcpClient(detectedClients) {
  log("cyan", "\n🤖 Which MCP-compatible client are you using?");

  const options = [
    ...detectedClients.map((c, i) => `${i + 1}. ${c.name} (detected)`),
    `${detectedClients.length + 1}. Claude Code (--add-mcp)`,
    `${detectedClients.length + 2}. Manual config (not supported yet)`,
  ];

  options.forEach((opt) => console.log(opt));
  const choice = await question(`\nEnter number (1-${options.length}): `);
  const idx = parseInt(choice, 10) - 1;

  if (idx >= 0 && idx < detectedClients.length) {
    return detectedClients[idx];
  } else if (idx === detectedClients.length) {
    return { name: "Claude Code", configPath: null, type: "claude-code" };
  } else {
    log("yellow", "Invalid choice. Defaulting to Claude Desktop config.");
    return detectedClients[0] || { name: "Claude Desktop", configPath: null, type: "claude-desktop" };
  }
}

async function askOutputDir() {
  const defaultOutput = path.join(HOME, "Desktop/gaea_output");
  const dir = await question(
    `\nHeightmap output folder [${defaultOutput}]: `
  );
  const chosen = dir || defaultOutput;
  if (!fs.existsSync(chosen)) {
    fs.mkdirSync(chosen, { recursive: true });
  }
  log("green", `[OK] Output folder: ${chosen}`);
  return chosen;
}

function buildProject() {
  const distPath = path.join(REPO_ROOT, "dist/index.js");
  if (fs.existsSync(distPath)) {
    log("green", "[OK] Build already exists, skipping build step");
    return true;
  }
  log("cyan", "\n📦 Installing dependencies and building...");
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const execOpts = { cwd: REPO_ROOT, stdio: "inherit" };
  try {
    execSync(`"${npm}" install`, execOpts);
    execSync(`"${npm}" run build`, execOpts);
    log("green", "[OK] Build complete");
    return true;
  } catch (e) {
    log("red", `Build failed: ${e.message}`);
    log("red", "Please run manually: npm install && npm run build");
    return false;
  }
}

function writeSwarmhostConfig(gaeaExePath, buildManagerPath, outputDir) {
  const config = {
    execPath: buildManagerPath || "C:\\Path\\To\\Gaea.BuildManager.exe",
    port: 0,
    outputDir,
    gaeaExePath: gaeaExePath || "",
  };
  const configPath = path.join(REPO_ROOT, "swarmhost.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  log("green", `[OK] Config written: ${configPath}`);
  return configPath;
}

function patchClaudeDesktopConfig(configPath, distPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!cfg.mcpServers) {
      cfg.mcpServers = {};
    }
    cfg.mcpServers["gaea-mcp"] = {
      command: "node",
      args: [distPath],
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    log("green", "[OK] Claude Desktop config patched");
    return true;
  } catch (e) {
    log("yellow", `[WARN] Could not patch ${configPath}: ${e.message}`);
    return false;
  }
}

function patchCursorConfig(configPath, distPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!cfg.mcpServers) {
      cfg.mcpServers = {};
    }
    cfg.mcpServers.gaea = {
      command: "node",
      args: [distPath],
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    log("green", "[OK] Cursor MCP config patched");
    return true;
  } catch (e) {
    log("yellow", `[WARN] Could not patch Cursor config: ${e.message}`);
    return false;
  }
}

function patchVSCodeSettings(configPath, distPath) {
  try {
    let settings = {};
    if (fs.existsSync(configPath)) {
      settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
    // Note: VSCode doesn't natively support MCP yet, but we can document the manual setup
    log("yellow", "[NOTE] VSCode MCP support is editor-specific. See manual setup instructions.");
    return false;
  } catch (e) {
    return false;
  }
}

async function main() {
  log("cyan", "\n╔════════════════════════════════════╗");
  log("cyan", "║     GaeaMCP Installer v1.0        ║");
  log("cyan", "╚════════════════════════════════════╝\n");

  checkNodeVersion();

  const gaeaExePath = detectGaea();
  const buildManagerPath = findBuildManager(gaeaExePath);

  const detectedClients = detectMcpClients();
  if (detectedClients.length === 0) {
    log("yellow", "\n[WARN] No MCP clients detected. Please install Claude Desktop or another MCP-compatible tool.");
  } else {
    log("green", `[OK] Found ${detectedClients.length} MCP client(s)`);
  }

  const selectedClient = await selectMcpClient(detectedClients);
  const outputDir = await askOutputDir();

  if (!buildProject()) {
    process.exit(1);
  }

  const distPath = path.join(REPO_ROOT, "dist/index.js");
  writeSwarmhostConfig(gaeaExePath, buildManagerPath, outputDir);

  if (selectedClient.configPath) {
    if (selectedClient.type === "claude-desktop") {
      patchClaudeDesktopConfig(selectedClient.configPath, distPath);
    } else if (selectedClient.type === "cursor") {
      patchCursorConfig(selectedClient.configPath, distPath);
    } else if (selectedClient.type === "vscode") {
      patchVSCodeSettings(selectedClient.configPath, distPath);
    }
  } else if (selectedClient.type === "claude-code") {
    log("cyan", "\n📝 Claude Code MCP Setup:");
    log("cyan", `Run in your project: claude mcp add gaea-mcp -- node ${distPath}`);
  }

  log("green", "\n╔════════════════════════════════════╗");
  log("green", "║   Installation Complete! ✓        ║");
  log("green", "╚════════════════════════════════════╝\n");
  log("cyan", "📖 Next steps:");
  log("cyan", "1. Restart your MCP-compatible AI client");
  log("cyan", "2. Try: 'Build me a snowy mountain range'");
  log("cyan", "3. Visit: https://github.com/zajalist/gaea_mcp\n");

  rl.close();
}

main().catch((e) => {
  log("red", `Error: ${e.message}`);
  process.exit(1);
});
