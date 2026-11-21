const { app, BrowserWindow, Menu, ipcMain, safeStorage, clipboard, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { newChat, runTurn } = require('./session.cjs');
const { createLLMClient } = require('./provider.cjs');
const page = path.join(__dirname, 'Resources/chat/index.html');
const settingsPage = path.join(__dirname, 'settings.html');
let win, settings, active, chats, current, config, timer;
app.setName('Hayba Desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox('Hayba Desktop', 'Could not open desktop data. Your saved files have been preserved.');
      app.quit();
    });
}
const data = (name) => path.join(app.getPath('userData'), name);
function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(data(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
function save(name, value) {
  const file = data(name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function saveChats() {
  save('conversations.json', { chats, current: current.id });
}
function secureWindow(options) {
  const window = new BrowserWindow({
    ...options,
    backgroundColor: '#171819',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}
function trusted(event, window, file) {
  return (
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(file).href
  );
}
function publish() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('snapshot', {
    generation: current.id,
    messages: current.messages,
    busy: !!active,
    canSend: !!config,
    workspace: {
      project: 'Hayba Desktop',
      title: current.messages[0]?.text.slice(0, 70) || 'New conversation',
      sessionId: current.id,
      sessions: chats.map((c) => ({
        id: c.id,
        updatedAt: c.updatedAt,
        title: c.messages[0]?.text.slice(0, 70) || 'New conversation',
      })),
      model: { name: config?.model || 'Choose provider', locked: true },
      mode: 'explore',
      credentialSetupRequired: !config,
    },
  });
}
function openSettings() {
  if (active) return;
  if (settings && !settings.isDestroyed()) {
    settings.focus();
    return;
  }
  settings = secureWindow({
    parent: win,
    modal: true,
    width: 475,
    height: 470,
    title: 'Provider settings',
    autoHideMenuBar: true,
  });
  settings.loadFile(settingsPage);
}
async function start() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const stored = load('conversations.json', null);
  chats = stored?.chats || [newChat()];
  current = chats.find((c) => c.id === stored?.current) || chats[0];
  config = load('provider.json', null);
  win = secureWindow({ width: 960, height: 760, minWidth: 400, minHeight: 460, title: 'Hayba Desktop' });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Hayba', submenu: [{ label: 'Provider settings…', click: openSettings }, { role: 'quit' }] },
      { role: 'editMenu' },
    ]),
  );
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ipcMain.handle('provider-info', (event) => {
    if (trusted(event, settings, settingsPage)) return { provider: config?.provider, model: config?.model };
  });
  ipcMain.handle('provider-save', (event, value) => {
    if (!trusted(event, settings, settingsPage) || active) return false;
    if (value === null) {
      fs.rmSync(data('provider.json'), { force: true });
      config = null;
    } else {
      if (
        !['openai', 'anthropic'].includes(value.provider) ||
        typeof value.model !== 'string' ||
        !/^[\w.:-]{1,160}$/.test(value.model) ||
        typeof value.key !== 'string' ||
        (!value.key.trim() && !(config?.provider === value.provider && config.secret)) ||
        value.key.length > 4096 ||
        !safeStorage.isEncryptionAvailable()
      )
        return false;
      const next = {
        provider: value.provider,
        model: value.model,
        secret: value.key.trim() ? safeStorage.encryptString(value.key.trim()).toString('base64') : config.secret,
      };
      save('provider.json', next);
      config = next;
    }
    settings.close();
    publish();
    return true;
  });
  ipcMain.handle('command', async (event, cmd) => {
    if (!trusted(event, win, page) || typeof cmd?.value !== 'string') return;
    const { action, value } = cmd;
    if (action === 'ready') {
      publish();
      return current.draft;
    }
    if (cmd.generation !== current.id) return;
    if (action === 'settings') openSettings();
    if (action === 'copy') clipboard.writeText(value);
    if (action === 'stop') active?.abort();
    if (action === 'draft_changed') {
      current.draft = value;
      clearTimeout(timer);
      timer = setTimeout(saveChats, 250);
    }
    if (action === 'send' && !active && config && value.trim()) {
      const key = safeStorage.decryptString(Buffer.from(config.secret, 'base64'));
      const client = createLLMClient({ provider: config.provider, model: config.model, apiKey: key });
      active = new AbortController();
      void runTurn(current, value, client, active.signal, publish).finally(() => {
        active = null;
        saveChats();
        publish();
        if (current.draft) win?.webContents.send('draft', current.draft);
      });
      saveChats();
    }
    if (!active && (action === 'new' || action === 'session')) {
      if (action === 'new') {
        current = newChat();
        chats.unshift(current);
      } else current = chats.find((c) => c.id === value) || current;
      saveChats();
      publish();
      win.webContents.send('draft', current.draft);
    }
    if (action === 'history' || action === 'resync') publish();
  });
  win.on('close', () => {
    active?.abort();
    clearTimeout(timer);
    saveChats();
  });
  win.on('closed', () => {
    win = null;
  });
  await win.loadFile(page);
}
app.on('window-all-closed', () => app.quit());
