const { app, BrowserWindow, Menu, ipcMain, safeStorage, clipboard, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runTurn } = require('./session.cjs');
const { openHistory, changeHistory, serializeHistory, chatTitle, historyRows } = require('./history.cjs');
const { normalizePreferences, updatePreferences } = require('./preferences.cjs');
const { openLighting } = require('./lighting-mcp.cjs');
const { LightingSession } = require('./lighting.cjs');
const { createLLMClient, listProviders, getProvider, normalizeOpenAIBaseURL } = require('./provider.cjs');
const { UETcpClient, discoverPortFromInstanceRegistry } = require('./editor-client.cjs');
const page = path.join(__dirname, 'workspace.html');
const settingsPage = path.join(__dirname, 'settings.html');
let win, settings, active, chats, current, config, timer, preferences;
let lighting,
  lightingBusy = false;
function disconnectLights() {
  if (lighting) void lighting.close().catch(() => {});
  lighting = undefined;
}
async function getLights(project) {
  if (!lighting) {
    const chat = current;
    const mcp = await openLighting(project);
    if (current !== chat || sharedProjects.get(chat.id) !== project || !win) {
      await mcp.close();
      throw Error('The conversation or project changed.');
    }
    lighting = new LightingSession(
      mcp,
      chat,
      () => {
        saveChats();
        publish();
      },
      project,
    );
  }
  return lighting;
}
// Sharing lasts for the selected conversation and is cleared when the app exits.
const sharedProjects = new Map();
let projectModes = {};
const projectKey = (file) => path.resolve(file).toLowerCase();
const automaticFor = (file) => Boolean(file && projectModes[projectKey(file)] === 'automatic');
app.setName('Hayba Desktop');
if (process.platform === 'win32') app.setAppUserModelId('Hayba.Desktop');
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
  save('conversations.json', serializeHistory(chats, current));
}
function secureWindow(options) {
  const window = new BrowserWindow({
    ...options,
    icon: path.join(__dirname, 'Hayba.ico'),
    backgroundColor: '#1d1b19',
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
  const sharedProject = sharedProjects.get(current.id);
  win.webContents.send('snapshot', {
    generation: current.id,
    messages: current.messages,
    busy: !!active,
    lightingBusy,
    activeLightingId: lighting?.record?.id,
    canSend: !!config,
    workspace: {
      project: 'Hayba Desktop',
      sharedProject: sharedProject ? path.basename(sharedProject, '.uproject') : null,
      title: chatTitle(current),
      sessionId: current.id,
      sessions: historyRows(chats),
      archivedSessions: historyRows(chats, true),
      preferences: {
        sendShortcut: preferences.sendShortcut, transcriptSize: preferences.transcriptSize,
        density: preferences.density, followOutput: preferences.followOutput,
        expandToolDetails: preferences.expandToolDetails,
      },
      model: { name: config?.model || 'Choose provider', locked: true },
      mode: automaticFor(sharedProject) ? 'automatic' : 'review',
      credentialSetupRequired: !config,
    },
  });
}
function openSettings() {
  if (active || lightingBusy) return;
  if (settings && !settings.isDestroyed()) {
    settings.focus();
    return;
  }
  settings = secureWindow({
    parent: win,
    modal: true,
    width: 820,
    height: 650,
    minWidth: 560,
    minHeight: 480,
    title: 'Settings',
    autoHideMenuBar: true,
  });
  settings.loadFile(settingsPage);
}
function selectSharedProject(item) {
  if (active || lightingBusy) {
    item.checked = sharedProjects.has(current.id);
    return;
  }
  if (!item.checked) {
    disconnectLights();
    sharedProjects.delete(current.id);
    publish();
    return;
  }
  const files = dialog.showOpenDialogSync(win, {
    title: 'Choose the open Unreal project whose level the provider may inspect',
    properties: ['openFile'],
    filters: [{ name: 'Unreal project', extensions: ['uproject'] }],
  });
  if (files?.[0]) sharedProjects.set(current.id, files[0]);
  item.checked = sharedProjects.has(current.id);
  publish();
}
async function inspectLevel(project, signal) {
  const root = path.dirname(project);
  const port = discoverPortFromInstanceRegistry(root);
  if (!port) throw Error('Project is offline');
  const editor = new UETcpClient('127.0.0.1', port);
  const disconnect = () => editor.disconnect();
  signal.throwIfAborted();
  signal.addEventListener('abort', disconnect, { once: true });
  try {
    await editor.connect();
    signal.throwIfAborted();
    const identity = await editor.send('project_get_info', {}, 5000);
    if (
      !identity.ok ||
      typeof identity.data?.project_dir !== 'string' ||
      path.relative(root, identity.data.project_dir) !== '' ||
      identity.data.project_name.toLowerCase() !== path.basename(project, '.uproject').toLowerCase()
    )
      throw Error('Editor project changed');
    const result = await editor.send('level_get_info', {}, 5000);
    if (!result.ok || typeof result.data?.map_name !== 'string') throw Error('Level unavailable');
    const { map_name, package_path, actor_count, is_pie_running } = result.data;
    return JSON.stringify({ map_name, package_path, actor_count, is_pie_running });
  } finally {
    signal.removeEventListener('abort', disconnect);
    disconnect();
  }
}
async function start() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const stored = load('conversations.json', null);
  ({ chats, current } = openHistory(stored));
  if (stored) saveChats();
  config = load('provider.json', null);
  preferences = normalizePreferences(load('preferences.json', {}));
  projectModes = load('project-modes.json', {});
  win = secureWindow({
    width: 1160,
    height: 800,
    autoHideMenuBar: true,
    minWidth: 400,
    minHeight: 460,
    title: 'Hayba Desktop',
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Hayba',
        submenu: [
          { label: 'Provider settings…', click: openSettings },
          {
            id: 'share-level',
            type: 'checkbox',
            label: 'Share Unreal level with provider…',
            click: selectSharedProject,
          },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
    ]),
  );
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ipcMain.handle('provider-info', (event) => {
    if (trusted(event, settings, settingsPage)) return {
      provider: config?.provider, model: config?.model, baseURL: config?.baseURL || '', hasKey: Boolean(config?.secret),
      providers: listProviders().filter((p) => p.id !== 'mock').map(({id,label,baseURLDefault,defaultModel,needsKey}) =>
        ({id,label,baseURLDefault,defaultModel,needsKey})),
    };
  });
  ipcMain.handle('preferences-info', (event) => {
    if (trusted(event, settings, settingsPage)) return preferences;
  });
  ipcMain.handle('preferences-save', (event, patch) => {
    if (!trusted(event, settings, settingsPage) || active || lightingBusy) return false;
    const next = updatePreferences(preferences, patch);
    save('preferences.json', next);
    preferences = next;
    publish();
    return preferences;
  });
  ipcMain.handle('provider-save', (event, value) => {
    if (!trusted(event, settings, settingsPage) || active) return false;
    if (value === null) {
      fs.rmSync(data('provider.json'), { force: true });
      config = null;
    } else {
      const provider = value && getProvider(value.provider);
      if (!provider || provider.id === 'mock' || typeof value.model !== 'string' ||
        !/^[\w./:-]{1,160}$/.test(value.model) || typeof value.key !== 'string' ||
        value.key.length > 4096 || typeof (value.baseURL ?? '') !== 'string') return false;
      let baseURL = '';
      if (value.baseURL?.trim()) {
        try {
          baseURL = normalizeOpenAIBaseURL(value.baseURL);
          const url = new URL(baseURL);
          if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return false;
        } catch { return false; }
      }
      if (provider.id === 'custom' && !baseURL) return false;
      const existingSecret = config?.provider === provider.id && (config.baseURL || '') === baseURL ? config.secret : '';
      if ((provider.needsKey && !value.key.trim() && !existingSecret) ||
          (value.key.trim() && !safeStorage.isEncryptionAvailable())) return false;
      const next = {
        provider: value.provider,
        model: value.model,
        baseURL,
        secret: value.key.trim() ? safeStorage.encryptString(value.key.trim()).toString('base64') : existingSecret || '',
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
    if (typeof action !== 'string') return;
    if (action === 'ready') {
      publish();
      return current.draft;
    }
    if (cmd.generation !== current.id) return;
    if (action === 'mode' && !active && !lightingBusy) {
      const project = sharedProjects.get(current.id);
      if (project && ['review', 'automatic'].includes(value)) {
        projectModes[projectKey(project)] = value;
        save('project-modes.json', projectModes);
        publish();
      }
      return;
    }
    if (action === 'lighting-cancel') {
      if (lighting?.record?.status === 'editor-review' && JSON.parse(value).token === lighting.record.token) {
        lighting.save({ status: 'cancelled' });
        disconnectLights();
      }
      return { ok: true };
    }
    if (action.startsWith('lighting-')) {
      if (lightingBusy || active) return { error: 'Finish the current operation first.' };
      const project = sharedProjects.get(current.id);
      if (!project) return { error: 'Select the open Unreal project first.' };
      lightingBusy = true;
      publish();
      try {
        const input = value ? JSON.parse(value) : {};
        const session = await getLights(project);
        if (action === 'lighting-list') return await session.mcp.call('lighting_list_loaded', {});
        if (action === 'lighting-inspect') await session.inspect(input.first, input.second);
        if (action === 'lighting-propose') {
          session.propose(input.id, input.target, input.intensity);
          if (automaticFor(project)) await session.decide('approve', session.record.token, true);
        }
        if (action === 'lighting-undo') {
          const saved = current.messages.find((m) => m.lighting?.id === input.id)?.lighting;
          if (!saved || saved.status !== 'applied' || saved.project !== project || saved.token !== input.token)
            throw Error('Reattach the same project and choose a verified edit to undo.');
          session.record = saved;
        }
        if (['lighting-approve', 'lighting-decline', 'lighting-undo'].includes(action))
          await session.decide(action.slice(9), input.token, automaticFor(project));
        return { ok: true };
      } catch (error) {
        if (action === 'lighting-list' || action === 'lighting-inspect') disconnectLights();
        return { error: error.message };
      } finally {
        lightingBusy = false;
        publish();
      }
    }
    if (lightingBusy && !['copy', 'draft_changed', 'resync'].includes(action)) return;
    if (action === 'settings') openSettings();
    if (action === 'project' && !active) {
      Menu.getApplicationMenu().getMenuItemById('share-level').click();
      return sharedProjects.has(current.id);
    }
    if (action === 'copy') clipboard.writeText(value);
    if (action === 'stop') active?.abort();
    if (action === 'draft_changed') {
      current.draft = value;
      current.updatedAt = new Date().toISOString();
      clearTimeout(timer);
      timer = setTimeout(() => { saveChats(); publish(); }, 250);
    }
    if (action === 'send' && !active && config && value.trim()) {
      const key = config.secret ? safeStorage.decryptString(Buffer.from(config.secret, 'base64')) : '';
      const client = createLLMClient({ provider: config.provider, model: config.model, apiKey: key, baseURL: config.baseURL || undefined });
      active = new AbortController();
      const sharedProject = sharedProjects.get(current.id);
      const inspect = sharedProject ? inspectLevel.bind(null, sharedProject) : undefined;
      const lights = sharedProject
        ? {
            automatic: automaticFor(sharedProject),
            context: lighting?.record?.observed?.map(({ label, intensity }) => ({ label, intensity })),
            async inspect(first, second) {
              const session = await getLights(sharedProject);
              const record = await session.inspect(first, second);
              return record.baseline.map(({ label, intensity }) => ({ label, intensity }));
            },
            async propose(target, intensity) {
              const record = lighting?.record;
              const matches = record?.baseline.filter((light) => light.label === target || light.actor_id === target);
              if (!record || matches.length !== 1) throw Error('Inspect the two named lights first.');
              const proposal = lighting.propose(record.id, matches[0].id, intensity);
              if (!this.automatic) return { pendingApproval: proposal };
              active.signal.throwIfAborted();
              await lighting.decide('approve', record.token, true, active.signal);
              return lighting.receipt('applied');
            },
            async undo() {
              if (!this.automatic) throw Error('Choose Undo intensity change on the verified lighting card.');
              const saved = current.messages.findLast((m) => m.lighting?.project === sharedProject &&
                m.lighting.status === 'applied')?.lighting;
              if (!saved) throw Error('There is no verified lighting edit to undo.');
              const session = await getLights(sharedProject);
              active.signal.throwIfAborted();
              session.record = saved;
              await session.decide('undo', saved.token, true, active.signal);
              return session.receipt('undone');
            },
          }
        : undefined;
      void runTurn(current, value, client, active.signal, publish, inspect, lights, preferences).finally(() => {
        active = null;
        saveChats();
        publish();
        if (current.draft) win?.webContents.send('draft', current.draft);
      });
      saveChats();
    }
    if (!active && ['new','session','archive','restore'].includes(action)) {
      const next = changeHistory(chats, current, action, value);
      const switching = next.current.id !== current.id;
      if (switching) disconnectLights();
      if (action === 'archive') sharedProjects.delete(value);
      ({ chats, current } = next);
      Menu.getApplicationMenu().getMenuItemById('share-level').checked = sharedProjects.has(current.id);
      saveChats();
      publish();
      if (switching) win.webContents.send('draft', current.draft);
    }
    if (action === 'history' || action === 'resync') publish();
  });
  win.on('close', () => {
    disconnectLights();
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
