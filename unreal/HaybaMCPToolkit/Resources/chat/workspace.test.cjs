const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('shared workspace: drafts, menus, context, provider states and responsive surfaces', async () => {
  const server = spawn(process.execPath, [path.resolve(__dirname, '../../../../tools/chat-ui-preview.mjs')], {
    windowsHide: true,
  });
  const url = await new Promise((resolve, reject) => {
    server.stdout.on('data', (data) => {
      const m = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error('Preview server exited ' + code)));
  });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHAT_TEST_CHROMIUM ? { executablePath: process.env.CHAT_TEST_CHROMIUM } : {}),
  });
  const captures = process.env.CHAT_TEST_CAPTURES;
  if (captures) fs.mkdirSync(captures, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' }),
      errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    const f = page.frameLocator('#workspace-frame');
    await f.locator('#model-label').filter({ hasText: 'Claude Opus' }).waitFor();
    await page.evaluate(() => {
      window.commands = [];
      window.addEventListener('message', (e) => {
        if (e.data.haybaPreview) window.commands.push(e.data.haybaPreview);
      });
    });
    const capture = async (name) => {
      if (captures)
        await page.locator('#workspace-frame').screenshot({ path: path.join(captures, 'workspace-' + name + '.png') });
    };
    for (const width of [350, 460, 900]) {
      await page.locator('#workspace-frame').evaluate((n, w) => (n.style.width = w + 'px'), width);
      await capture('empty-' + width);
      assert.equal(
        await f.locator('body').evaluate((n) => n.scrollWidth <= innerWidth && n.scrollHeight <= innerHeight),
        true,
      );
      const composer = await f.locator('#composer').boundingBox();
      assert.ok(composer.y + composer.height <= 900);
    }
    await f.locator('#prompt').fill('A draft that must survive');
    await page.waitForFunction(() => state.workspace.draft.text === 'A draft that must survive');
    await page.evaluate(() => {
      const stale = structuredClone(state);
      stale.workspace.draft = { text: 'old draft', ack: 0, revision: 0 };
      document.getElementById('workspace-frame').contentWindow.haybaChat.receive(stale);
    });
    assert.equal(await f.locator('#prompt').inputValue(), 'A draft that must survive');
    await f.locator('#more-button').click();
    await f.getByRole('button', { name: /Editor status/ }).click();
    await f.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.waitForFunction(() => window.commands.some((c) => c.action === 'diagnostics'));
    await page.evaluate(() => {
      Object.assign(state.workspace.diagnostics, { restartRequired: true, mustNotSave: true, api_key: 'never-copy-this-secret' });
      push();
    });
    await f.getByText('Do not save. A native fault left the editor unsafe; restart the editor before continuing.', { exact: true }).waitFor();
    await capture('editor-status');
    await f.getByRole('button', { name: 'Copy summary', exact: true }).click();
    await page.waitForFunction(() => window.commands.some((c) => c.action === 'copy' && c.value.includes('Local MCP listener')));
    const summary = await page.evaluate(() => window.commands.findLast((c) => c.action === 'copy').value);
    assert.ok(summary.includes('Do not save.'));
    assert.ok(!summary.includes('never-copy-this-secret'));
    assert.equal(await f.locator('#prompt').inputValue(), 'A draft that must survive');
    await page.keyboard.press('Escape');
    await f.locator('#create-button').click();
    await f.getByRole('button', { name: /Browse Fab assets/ }).click();
    await f.getByRole('button', { name: 'Open Fab in Unreal', exact: true }).click();
    await page.waitForFunction(() => window.commands.some((c) => c.action === 'fab_browser'));
    assert.equal(await f.getByRole('button', { name: 'Draft a Fab search', exact: true }).isDisabled(), true);
    await f.getByLabel('What are you looking for?').fill('modular stone ruins');
    await capture('fab-assets');
    await f.getByRole('button', { name: 'Draft a Fab search', exact: true }).click();
    await page.waitForFunction(() => window.commands.some((c) => c.action === 'draft' && c.value.includes('modular stone ruins')));
    await page.waitForTimeout(100);
    assert.ok((await f.locator('#prompt').inputValue()).startsWith('A draft that must survive'));
    assert.ok((await f.locator('#prompt').inputValue()).includes('Search Fab for modular stone ruins'));
    await f.locator('#model-button').click();
    await f.getByRole('searchbox', { name: 'Search models…' }).fill('Sonnet');
    assert.equal(await f.locator('.menu-list .menu-row').count(), 1);
    await capture('models');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await f.locator('#model-label').filter({ hasText: 'Sonnet' }).waitFor();
    assert.equal(await f.locator('#model-button').evaluate((n) => document.activeElement === n), true);
    for (const [id, name] of [
      ['history-button', 'history'],
      ['effort-button', 'effort'],
      ['mode-button', 'access'],
    ]) {
      await f.locator('#' + id).click();
      await capture(name);
      await page.keyboard.press('Escape');
      assert.equal(await f.locator('#' + id).evaluate((n) => document.activeElement === n), true);
    }
    await f.locator('#mode-button').click();
    await f.getByRole('button', { name: 'Production Propose and verify reviewed changes.' }).click();
    await f.locator('#mode-label').filter({ hasText: 'Production' }).waitFor();
    await f.locator('#attach-button').click();
    await f.getByRole('button', { name: 'Editor selection Reference selected actors and assets' }).click();
    await f.getByRole('button', { name: 'Remove 3 selected actors' }).waitFor();
    await capture('context');
    await f.getByRole('button', { name: 'View context: 3 selected actors' }).click();
    await f.getByText('/Game/Maps/Entrance', { exact: true }).waitFor();
    await capture('context-details');
    await page.keyboard.press('Escape');
    await f.getByRole('button', { name: 'Remove 3 selected actors' }).click();
    await f.locator('#more-button').click();
    await f.getByRole('button', { name: 'Connections 3D models, video and splat worlds' }).click();
    await capture('connections');
    assert.equal(await f.locator('input[type=password]').count(), 0);
    await f.getByRole('button', { name: 'Connect', exact: true }).first().click();
    await f.locator('#toast').filter({ hasText: 'secure dialog' }).waitFor();
    assert.equal(await f.getByText('Simulated · Not connected', { exact: true }).count(), 5);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      state.workspace.connections.forEach((c) =>
        Object.assign(c, { configured: true, state: 'verified', message: 'Preview fixture' }),
      );
      push();
    });
    await f.locator('#create-button').click();
    await f.getByLabel('Describe your asset').fill('Weathered brass lantern');
    await capture('create-3d');
    await f.getByRole('button', { name: 'Generate asset', exact: true }).click();
    await f.locator('.job').waitFor();
    const command = await page.evaluate(() => window.commands.findLast((c) => c.action === 'generate_3d'));
    assert.equal(command.value, 'meshy');
    assert.equal(command.prompt, 'Weathered brass lantern');
    assert.equal('provider' in command, false);
    assert.equal('api_key' in command, false);
    await capture('job-running');
    await f.getByRole('button', { name: 'Open result' }).waitFor();
    await capture('job-result');
    await f.getByRole('button', { name: 'Add textures…' }).click();
    assert.equal(await page.evaluate(() => window.commands.filter((c) => c.action === 'generate_3d').length), 1);
    await f.getByText('This submits a separate paid generation', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => scene('conversation'));
    await capture('conversation-900');
    await f.locator('#history-button').click();
    assert.equal(await f.locator('.menu-row[aria-current=true]').count(), 1);
    await capture('history-current');
    await page.keyboard.press('Escape');
    for (const width of [350, 460]) {
      await page.locator('#workspace-frame').evaluate((n, w) => (n.style.width = w + 'px'), width);
      await capture('conversation-' + width);
      assert.equal(await f.locator('body').evaluate((n) => n.scrollWidth <= innerWidth), true);
    }
    await page.evaluate(() => scene('approval'));
    await f.locator('.activity > summary').click();
    await capture('approval-460');
    await f.getByRole('button', { name: 'Review action', exact: true }).click();
    assert.equal(
      await f.getByRole('button', { name: 'Approve once', exact: true }).evaluate((n) => {
        const r = n.getBoundingClientRect(),
          p = document.getElementById('conversation').getBoundingClientRect();
        return r.top >= p.top && r.bottom <= p.bottom;
      }),
      true,
    );
    await capture('approval-actionable');
    assert.equal(await f.locator('#latest').isVisible(), false);
    await page.evaluate(() => {
      state.workspace.credentialSetupRequired = true;
      push();
    });
    await f.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    await page.evaluate(() => scene('empty'));
    await f.locator('#prompt').fill('Hello from the new workspace');
    await page.keyboard.press('Enter');
    await f.getByRole('button', { name: 'Stop response' }).waitFor();
    await f.locator('#prompt').fill('Keep this follow-up');
    await f.getByRole('button', { name: 'Stop response' }).click();
    assert.equal(await f.locator('#prompt').inputValue(), 'Keep this follow-up');
    await page.evaluate(() => scene('long'));
    assert.equal(await f.locator('#messages>article').count(), 80);
    await f.getByRole('button', { name: /Earlier messages/ }).click();
    assert.equal(await f.locator('#messages>article').count(), 80);
    await f.locator('#find-button').click();
    await f.getByRole('searchbox', { name: 'Find a message…' }).fill('investigation 16:');
    assert.equal(await f.locator('.turn-list .menu-row').count(), 1);
    await capture('long-history-search');
    await f.locator('.turn-list .menu-row').click();
    assert.ok((await f.locator('#messages>article').first().innerText()).includes('15'));
    await f.locator('#latest').click();
    assert.equal(await f.locator('#messages>article').count(), 80);
    await f.locator('#history-button').click();
    await f.getByRole('button', { name: 'Next', exact: true }).click();
    await f.getByText('51–100 of 125', { exact: true }).waitFor();
    await f.getByRole('searchbox', { name: 'Search conversations…' }).fill('investigation 125');
    await f.getByText('1–1 of 1', { exact: true }).waitFor();
    assert.equal(await f.locator('.thread-list .menu-row').count(), 1);
    await capture('thread-search');
    await f.getByRole('searchbox', { name: 'Search conversations…' }).fill(' sample-124 ');
    await f.getByText('1–1 of 1', { exact: true }).waitFor();
    assert.equal(await f.locator('.thread-list .menu-row').count(), 1);
    await f.getByRole('tab', { name: 'Agents', exact: true }).click();
    assert.equal(await f.locator('.agent-list textarea').count(), 0);
    assert.equal(await f.getByRole('button', { name: 'Start subagent' }).count(), 0);
    await capture('subagents');
    await page.keyboard.press('Escape');
    await f.locator('#prompt').fill('Delegate an inspection of the entrance lighting and summarize the findings.');
    await page.keyboard.press('Enter');
    await f.locator('#delegated-activity .menu-row').waitFor();
    await capture('delegation-inline');
    await f.locator('#delegated-activity .menu-row').click();
    await page.evaluate(() => {
      state.workspace.subagents.agents[0].output = 'Partial findings';
      state.workspace.subagents.loading = true;
      push();
    });
    assert.equal(await f.getByRole('button', { name: 'Use findings in chat', exact: true }).count(), 0);
    assert.equal(await f.getByRole('button', { name: 'Updating task…', exact: true }).isDisabled(), true);
    await page.evaluate(() => {
      state.workspace.subagents.loading = false;
      push();
    });
    await f.getByRole('button', { name: 'Use findings in chat', exact: true }).waitFor();
    await capture('subagent-detail');
    await f.locator('#prompt').evaluate((n) => {
      n.value = 'A draft typed immediately before using findings';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await f.getByRole('button', { name: 'Use findings in chat', exact: true }).click();
    await page.waitForTimeout(200);
    assert.ok((await f.locator('#prompt').inputValue()).includes('subagent findings'));
    await page.evaluate(() => {
      state.workspace.connections.forEach((c) =>
        Object.assign(c, { configured: true, state: c.id === 'fal' ? 'configured' : 'verified' }),
      );
      push();
    });
    await f.locator('#create-button').click();
    await f.getByRole('button', { name: 'Video', exact: true }).click();
    await f.getByLabel('Describe your asset').fill('A cinematic camera move through the station');
    assert.equal(await f.getByLabel('Reference image URL (optional)').count(), 0);
    await capture('create-video');
    await f.getByRole('button', { name: 'Generate video', exact: true }).click();
    await page.waitForFunction(() => window.commands.some((c) => c.action === 'generate_3d' && c.value === 'fal'));
    await f.getByRole('button', { name: 'Splat world', exact: true }).click();
    await capture('create-splat');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
  }
});
