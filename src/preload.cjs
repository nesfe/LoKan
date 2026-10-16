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
  syncInvite: name => ipcRenderer.invoke('sync:invite', name),
  syncInvites: () => ipcRenderer.invoke('sync:invite-list'),
  syncRevoke: id => ipcRenderer.invoke('sync:revoke', id),
  syncJoin: (code, name) => ipcRenderer.invoke('sync:join', code, name),
  cloudStart: () => ipcRenderer.invoke('cloud:start'),
  cloudPoll: () => ipcRenderer.invoke('cloud:poll'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpConfigure: options => ipcRenderer.invoke('mcp:configure', options),
  mcpRotate: () => ipcRenderer.invoke('mcp:rotate'),
  mcpCopy: () => ipcRenderer.invoke('mcp:copy'),
  onSyncStatus: callback => ipcRenderer.on('sync:status', (_event, status) => callback(status)),
  onSyncState: callback => ipcRenderer.on('sync:state', (_event, state) => callback(state))
});
