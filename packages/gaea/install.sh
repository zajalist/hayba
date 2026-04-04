#!/bin/bash
# GaeaMCP Installer for macOS and Linux
# Detects Gaea installation (Windows only), configures MCP clients, runs setup

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "╔════════════════════════════════════╗"
echo "║     GaeaMCP Installer v1.0        ║"
echo "╚════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌ Node.js 20+ required. Found: $NODE_VERSION"
    exit 1
fi

echo "✓ Node.js $NODE_VERSION"
echo ""

# Note: Gaea is Windows-only, so we skip Gaea detection on macOS/Linux
echo "📝 Note: Gaea is Windows-only. If you're using this on macOS/Linux,"
echo "         you'll be using headless mode (no Gaea.exe launches)."
echo ""

# Run the Node.js installer
node "$SCRIPT_DIR/installer/index.js"
