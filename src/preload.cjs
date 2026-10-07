const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lokan', {
  load: () => ipcRenderer.invoke('data:load'),
  save: state => ipcRenderer.invoke('data:save', state),
  export: () => ipcRenderer.invoke('data:export'),
  import: () => ipcRenderer.invoke('data:import'),
  dataPath: () => ipcRenderer.invoke('data:path')
});
