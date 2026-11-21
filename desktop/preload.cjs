const { contextBridge, ipcRenderer } = require('electron');
if (location.pathname.endsWith('/settings.html')) {
  contextBridge.exposeInMainWorld('providerSettings', {
    info: () => ipcRenderer.invoke('provider-info'),
    save: (value) => ipcRenderer.invoke('provider-save', value),
  });
} else {
  contextBridge.exposeInMainWorld('haybaDesktop', {
    command: (cmd) => ipcRenderer.invoke('command', cmd),
    onSnapshot: (callback) => ipcRenderer.on('snapshot', (_event, state) => callback(state)),
    onDraft: (callback) => ipcRenderer.on('draft', (_event, text) => callback(text)),
  });
}
