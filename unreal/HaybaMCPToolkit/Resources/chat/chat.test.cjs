// Run with node --test; PLAYWRIGHT_MODULE can point to an existing tooling install.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

test('local transcript: safe markup, streaming, selection, scroll, approvals and narrow layout', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHAT_TEST_CHROMIUM ? { executablePath: process.env.CHAT_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 650 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await page.evaluate(() => document.fonts.ready);
    const send = (state) => page.evaluate((next) => window.haybaChat.receive(next), state);
    const base = { generation: 'one', canSend: true, messages: [] };
    await send(base);
    assert.equal(await page.locator('#empty').isVisible(), true);
    const capture = process.env.CHAT_TEST_CAPTURES;
    if (capture) {
      fs.mkdirSync(capture, { recursive: true });
      await page.screenshot({ path: path.join(capture, 'empty-420.png') });
    }
    const text =
      'I found **three lights** near the entrance.\n\n## Suggested change\n- Keep the warm key light\n- Lower the fill intensity\n\n```cpp\nLight->SetIntensity(1200.f);\n```\n\n[Asset](/Game/Lighting/BP_Lamp.BP_Lamp)\n\n<script>window.pwned=true</script> [bad](javascript:alert(1))';
    let state = {
      ...base,
      messages: [
        { id: 0, role: 'user', text: 'Help me improve the lighting in this entrance.' },
        { id: 1, role: 'assistant', text },
      ],
    };
    await send(state);
    assert.equal(await page.locator('.body strong').textContent(), 'three lights');
    assert.equal(await page.locator('pre code').textContent(), 'Light->SetIntensity(1200.f);');
    assert.equal(await page.locator('.body script').count(), 0);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('.body a').count(), 1);
    await page.evaluate(() => {
      window.oldRow = document.querySelector('article');
      window.oldBlock = document.querySelectorAll('.body')[1].firstChild;
    });
    state.messages[1].text += '\n\nI’ll check the result before proposing an edit.';
    state.busy = true;
    await send(state);
    assert.equal(
      await page.evaluate(
        () =>
          window.oldRow === document.querySelector('article') &&
          window.oldBlock === document.querySelectorAll('.body')[1].firstChild,
      ),
      true,
    );
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.body p'));
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
    });
    const selected = await page.evaluate(() => getSelection().toString());
    state.messages[1].text += '\n\nPending selection update.';
    await send(state);
    assert.equal(await page.evaluate(() => getSelection().toString()), selected);
    assert.equal(await page.getByText('Pending selection update.').count(), 0);
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.getByText('Pending selection update.').waitFor();
    const activity = {
      id: 'a1',
      title: 'Inspect entrance lighting',
      state: 'Awaiting approval',
      steps: [
        {
          id: 's1',
          name: 'Read selected actors',
          state: 'Succeeded',
          input: '{"selection":true}',
          result: '3 lights found',
        },
      ],
      approval: {
        id: 'approval1',
        input: 'actor_set_property\n{"Intensity":1200}',
        hint: 'Update the selected light intensity. Save separately.',
        native: false,
        enabled: true,
      },
    };
    state.messages[1].activity = activity;
    state.busy = false;
    state.awaitingApproval = true;
    await send(state);
    await page.locator('.activity > summary').click();
    await page.getByRole('button', { name: 'Approve once' }).focus();
    activity.steps.push({ id: 's2', name: 'Validate target', state: 'Succeeded', input: '{"target":"Light"}' });
    await send(state);
    assert.equal(await page.locator('.activity').getAttribute('open'), '');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Approve once');
    await page.locator('[data-focus-key="s2input"]').focus();
    activity.steps[1].result = 'Target is unchanged';
    await send(state);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), 's2input');
    activity.approval.native = true;
    await send(state);
    assert.equal(await page.getByRole('button', { name: 'Approve once' }).count(), 0);
    assert.equal(await page.getByText('Review the exact operation in the Unreal approval panel above.').count(), 1);
    state.messages[1].text =
      'I found **three lights** near the entrance. The fill is competing with the warm key light.\n\n## Suggested change\n- Keep the warm key light\n- Lower the fill intensity\n- Check the result from the player camera\n\n```cpp\nLight->SetIntensity(1200.f);\n```\n\nThe proposed edit is ready for your review.';
    await send(state);
    for (const width of [350, 420, 900]) {
      await page.setViewportSize({ width, height: 650 });
      await page.evaluate(() => (document.querySelector('#conversation').scrollTop = 0));
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.querySelector('#conversation').scrollWidth <= document.querySelector('#conversation').clientWidth,
        ),
        true,
      );
      if (capture) await page.screenshot({ path: path.join(capture, `conversation-${width}.png`) });
    }
    state = {
      ...base,
      messages: Array.from({ length: 24 }, (_, i) => ({
        id: i,
        role: i % 2 ? 'assistant' : 'user',
        text: 'Message ' + i + '\n\n' + 'A readable paragraph. '.repeat(10),
      })),
    };
    await send(state);
    await page.evaluate(() => (document.querySelector('#conversation').scrollTop = 80));
    state.messages.push({ id: 24, role: 'assistant', text: 'A new reply' });
    await send(state);
    assert.equal(await page.evaluate(() => document.querySelector('#conversation').scrollTop), 80);
    assert.equal(await page.locator('#latest').isVisible(), true);
    await page.locator('#latest').click();
    assert.equal(await page.locator('#latest').isVisible(), false);
    await send({ ...base, generation: 'two' });
    assert.equal(await page.locator('article').count(), 0);
    assert.equal(await page.locator('#empty').isVisible(), true);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    const navigation = [];
    cdp.on('Page.frameRequestedNavigation', (event) => {
      if (event.url.startsWith('hayba-chat://event/'))
        navigation.push(JSON.parse(decodeURIComponent(event.url.slice('hayba-chat://event/'.length))));
    });
    await page.evaluate(() => window.haybaChat.init('document-token'));
    await page.waitForTimeout(100);
    assert.equal(navigation[0].action, 'ready');
    await page.evaluate(() => window.haybaChat.ack());
    await page.getByRole('button', { name: /Understand my selection/ }).click();
    await page.waitForTimeout(100);
    assert.equal(navigation.at(-1).action, 'draft');
    assert.equal(navigation.at(-1).token, 'document-token');
    assert.equal(navigation.at(-1).generation, 'two');
    await page.evaluate(() => window.haybaChat.ack());
    await send({
      ...base,
      generation: 'two',
      messages: [{ id: 0, role: 'assistant', text: '```cpp\nA < B && C;\n```' }],
    });
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(navigation.at(-1).action, 'copy');
    assert.equal(navigation.at(-1).value, 'A < B && C;');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
