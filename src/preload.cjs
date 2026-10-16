const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lokan', {
  load: () => ipcRenderer.invoke('data:load'),
  apply: action => ipcRenderer.invoke('data:apply', action),
  export: () => ipcRenderer.invoke('data:export'),
  import: () => ipcRenderer.invoke('data:import'),
  dataPath: () => ipcRenderer.invoke('data:path'),
  openLink: url => ipcRenderer.invoke('link:open', url),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncProbe: options => ipcRenderer.invoke('sync:probe', options),
  syncConnect: options => ipcRenderer.invoke('sync:connect', options),
  syncDisconnect: () => ipcRenderer.invoke('sync:disconnect'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncKeyFile: () => ipcRenderer.invoke('sync:key-file'),
  syncInvite: () => ipcRenderer.invoke('sync:invite'),
  onSyncStatus: callback => ipcRenderer.on('sync:status', (_event, status) => callback(status)),
  onSyncState: callback => ipcRenderer.on('sync:state', (_event, state) => callback(state))
});
