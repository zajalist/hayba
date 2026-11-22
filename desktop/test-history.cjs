const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function test() {
  const executablePath = process.argv[2];
  assert.ok(executablePath && fs.existsSync(executablePath), 'Pass the installed Hayba executable path.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hayba-history-'));
  const file = path.join(profile, 'conversations.json');
  const originalTitle = 'Review the entrance lighting';
  const draft = 'Keep these notes\nfor the next meeting.';
  const draftTitle = 'Keep these notes for the next meeting.';
  const messages = [
    { id: 0, role: 'user', text: originalTitle },
    { id: 1, role: 'assistant', text: 'The entrance has two lights.' },
  ];
  const blank = (id) => ({ id, updatedAt: '2026-01-03T12:00:00.000Z', draft: '', messages: [] });
  fs.writeFileSync(
    file,
    JSON.stringify({
      current: 'old-empty',
      chats: [blank('old-empty'), { ...blank('transcript'), messages }, blank('old-duplicate')],
    }),
  );
  const persisted = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  let app;
  let page;
  const button = (name, root = page) => root.getByRole('button', { name, exact: true });
  const nav = () => page.getByRole('navigation', { name: 'Conversations' });
  const dialog = (name) => page.getByRole('dialog', { name });
  const expectDraft = async (text) => {
    await page.waitForFunction((value) => document.querySelector('#prompt')?.value === value, text);
  };
  async function launch() {
    app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile] });
    page = await app.firstWindow();
    await button('New chat').waitFor();
  }
  try {
    await launch();
    const newChat = button('New chat');
    for (let i = 0; i < 3; i++) {
      // A disabled empty-state button must also ignore real pointer clicks.
      const bounds = await newChat.boundingBox();
      assert.ok(bounds);
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.keyboard.press('Control+n');
    }
    assert.equal(await nav().getByRole('button', { name: 'New conversation' }).count(), 0);
    assert.deepEqual(
      persisted().chats.map((c) => c.id),
      ['transcript'],
    );
    await page.locator('#prompt').fill(draft);
    await button('New chat').click();
    await expectDraft('');
    await button(draftTitle, nav()).waitFor();
    assert.equal(persisted().chats.length, 2);
    await page.keyboard.press('Control+k');
    const search = dialog('Find a conversation');
    await search.waitFor();
    assert.deepEqual(
      (await search.getByRole('button').allTextContents())
        .map((s) => s.trim())
        .filter(Boolean)
        .sort(),
      [draftTitle, originalTitle].sort(),
    );
    await button(draftTitle, search).click();
    await expectDraft(draft);

    // Archiving a background transcript keeps the active draft and its full whitespace.
    await button('Archive ' + originalTitle, nav()).click();
    await button(originalTitle, nav()).waitFor({ state: 'detached' });
    await expectDraft(draft);
    await page.keyboard.press('Control+k');
    await search.waitFor();
    assert.equal(await button(originalTitle, search).count(), 0);
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });
    await app.close();
    app = null;
    const archived = persisted().chats.find((c) => c.id === 'transcript');
    assert.ok(archived.archivedAt);
    assert.deepEqual(archived.messages, messages);

    await launch();
    await expectDraft(draft);
    assert.equal(await button(originalTitle, nav()).count(), 0);
    await button('Archived chats').click();
    const archive = dialog('Archived chats');
    const filter = archive.getByRole('textbox', { name: 'Search archived chats' });
    await filter.fill('no match');
    await archive.getByText('No matching archived chats.').waitFor();
    await filter.fill('ENTRANCE');
    await button('Restore ' + originalTitle, archive).click();
    await archive.getByText('No archived chats.').waitFor();
    await button('Close archived chats', archive).click();
    await expectDraft(draft);
    await button(originalTitle, nav()).click();
    await page.getByRole('article', { name: 'Hayba message' }).getByText(messages[1].text).waitFor();
    await expectDraft('');

    // Archiving the selected draft returns to the remaining conversation.
    await button(draftTitle, nav()).click();
    await expectDraft(draft);
    await button('Archive ' + draftTitle, nav()).click();
    await page.getByRole('article', { name: 'Hayba message' }).getByText(messages[1].text).waitFor();
    await expectDraft('');
    await app.close();
    app = null;
    const restored = persisted().chats.find((c) => c.id === 'transcript');
    assert.equal(restored.archivedAt, undefined);
    assert.deepEqual(restored.messages, messages);

    await launch();
    await page.getByRole('article', { name: 'Your message' }).getByText(originalTitle).waitFor();
    await button('Archived chats').click();
    const reopenedArchive = dialog('Archived chats');
    await button('Restore ' + draftTitle, reopenedArchive).click();
    await reopenedArchive.getByText('No archived chats.').waitFor();
    await page.keyboard.press('Escape');
    await reopenedArchive.waitFor({ state: 'hidden' });
    await button(draftTitle, nav()).click();
    await expectDraft(draft);
    console.log(
      'PASS: installed history migration, blank reuse, search, draft retention and persisted archive/restore across two restarts',
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

test().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
