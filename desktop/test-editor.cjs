const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

// Unreal intercepts custom-scheme navigations. Read the live DOM without waiting for a navigation to finish.
async function waitFor(page, predicate, value, description) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, value)) return;
    await delay(150);
  }
  throw Error(description);
}

async function main() {
  const [, , projectFile, port, screenshot] = process.argv;
  assert.ok(
    projectFile?.endsWith('.uproject') && /^\d+$/.test(port),
    'Supply a disposable .uproject and its CEF debug port.',
  );
  const chat = path.join(path.dirname(path.resolve(projectFile)), 'Plugins/HaybaMCPToolkit/Resources/chat/index.html');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  try {
    const page = browser
      .contexts()
      .flatMap((ctx) => ctx.pages())
      .find((page) => page.url() === pathToFileURL(chat).href);
    assert.ok(page, 'The installed Unreal chat tab must be open.');
    await waitFor(
      page,
      () => document.querySelector('#model-label')?.innerText === 'mock',
      null,
      'Select the offline mock model first.',
    );
    const prompt = 'Installer acceptance ' + Date.now();
    await page.evaluate((text) => {
      const field = document.querySelector('#prompt');
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#send-button').click();
    }, prompt);
    await waitFor(
      page,
      (text) =>
        [...document.querySelectorAll('article[aria-label="Hayba message"] .body')].some(
          (body) => body.innerText.trim() === 'echo: ' + text,
        ),
      prompt,
      'The assistant reply did not appear.',
    );
    console.log('The installed chat returned the provider reply.');
    await page.evaluate(() => document.querySelector('#new-button').click());
    await waitFor(page, () => document.querySelector('#empty')?.offsetHeight > 0, null, 'The new chat did not open.');
    await page.evaluate(() =>
      [...document.querySelectorAll('#empty button')].find((b) => b.innerText.includes('Explore the scene')).click(),
    );
    await waitFor(
      page,
      () => document.querySelector('#messages')?.innerText.includes('Current map:'),
      null,
      'The scene inspection did not return a map.',
    );
    console.log(await page.evaluate(() => document.querySelector('#messages').innerText.slice(0, 700)));
    if (screenshot) {
      const session = await page.context().newCDPSession(page);
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(screenshot, Buffer.from(data, 'base64'));
    }
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
