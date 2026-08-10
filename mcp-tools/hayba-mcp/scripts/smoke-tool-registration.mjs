#!/usr/bin/env node

// Rung-5 smoke test for issue #319: exercise the built MCP server through its
// real stdio transport. This is intentionally not a Vitest in-process server;
// it catches import-order, startup, registration, and child-process teardown
// failures that a fake McpServer cannot. The selected hidden tool is read-only
// and local, so the smoke never connects to or mutates an Unreal editor.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'hayba-registration-smoke-'));
const serverEntry = join(packageRoot, 'dist', 'index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: packageRoot,
  stderr: 'pipe',
  env: {
    ...process.env,
    HAYBA_SETTINGS_PATH: join(scratch, 'settings.json'),
    HAYBA_TOOL_ROUTING: 'deferred',
  },
});
const stderr = [];
transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
const client = new Client({ name: 'hayba-registration-smoke', version: '1.0.0' });
let stage = 'startup';

async function bounded(label, promise, timeoutMs = 20_000) {
  stage = label;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

try {
  await bounded('connect', client.connect(transport));
  const listed = await bounded('list tools', client.listTools());
  const visible = new Set(listed.tools.map((tool) => tool.name));
  for (const bootstrap of ['list_tool_categories', 'hayba_search_tools', 'hayba_invoke']) {
    assert(visible.has(bootstrap), `missing bootstrap tool ${bootstrap}`);
  }
  assert(!visible.has('memory_recall'), 'memory_recall should start hidden in deferred mode');

  const categories = await bounded('list categories', client.callTool({ name: 'list_tool_categories', arguments: {} }));
  assert.match(textOf(categories), /memory/i, 'category catalogue did not materialize');

  const search = await bounded(
    'search hidden tool',
    client.callTool({
      name: 'hayba_search_tools',
      arguments: { query: 'recall remembered project context', k: 10 },
    }),
  );
  assert.match(textOf(search), /memory_recall/, 'hidden tool was not searchable');

  const invoked = await bounded(
    'invoke hidden tool',
    client.callTool({
      name: 'hayba_invoke',
      arguments: {
        name: 'memory_recall',
        args: { text: '__hayba_registration_smoke_no_match__' },
      },
    }),
  );
  const invokedText = textOf(invoked);
  assert(!/unknown_tool/i.test(invokedText), 'hidden tool resolved as unknown');
  assert(!/tool_disabled/i.test(invokedText), 'hidden tool was unexpectedly disabled');

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        child_pid: transport.pid,
        bootstrap_tools: ['list_tool_categories', 'hayba_search_tools', 'hayba_invoke'],
        hidden_tool: 'memory_recall',
        hidden_tool_visible_initially: false,
        hidden_tool_searchable: true,
        hidden_tool_invokable: true,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const childDiagnostics = stderr.join('').split(/\r?\n/).slice(-20).join('\n');
  process.stderr.write(`registration smoke failed during ${stage}: ${detail}\n${childDiagnostics}\n`);
  process.exitCode = 1;
} finally {
  await bounded('close client', client.close(), 5_000).catch(async () => {
    await transport.close().catch(() => undefined);
  });
  rmSync(scratch, { recursive: true, force: true });
}
