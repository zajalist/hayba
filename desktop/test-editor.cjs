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
    await waitFor(page, () => document.querySelector('link[rel=icon]')?.getAttribute('href') === '../HaybaLogo.svg', null, 'The Unreal panel did not load the Hayba icon.');
    await waitFor(
      page,
      () => document.querySelector('#model-label')?.innerText === 'mock',
      null,
      'The installed HTML chat did not receive the configured mock model from Unreal.',
    );
    const prompt = 'Installer acceptance ' + Date.now();
    await page.evaluate(() => document.querySelector('#prompt').focus());
    await waitFor(page, () => getComputedStyle(document.querySelector('#composer')).borderTopColor === 'rgb(196, 122, 40)', null, 'Unreal did not render the focused composer outline.');
    const colors = await page.evaluate(() => {
      return {
        composer: getComputedStyle(document.querySelector('#composer')).borderTopColor,
        buttons: [...document.querySelectorAll('button')].map(el => getComputedStyle(el).backgroundColor),
      };
    });
    assert.equal(colors.composer, 'rgb(196, 122, 40)');
    assert.ok(colors.buttons.every(color => !['rgb(196, 122, 40)', 'rgb(208, 170, 115)'].includes(color)));
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
    if (screenshot === '--delayed') {
      const actual = await page.evaluate(() => window.haybaDelayedChatReadyAt);
      assert.ok(actual >= 12000, 'The fixture must delay the HTML chat past the old startup deadline.');
      console.log('Delayed HTML chat recovered after ' + Math.round(actual) + ' ms and completed a real editor request.');
    } else if (screenshot) {
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
