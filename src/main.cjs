const { app, BrowserWindow, ipcMain, dialog, session, Menu, shell, safeStorage, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SyncService } = require('./sync_service.cjs');

app.setName('LoKan');
app.setAppUserModelId('app.lokan.desktop');
app.disableHardwareAcceleration();
let window;
let saveQueue = Promise.resolve();
let sync;
let mcp;
let mcpReady;
let stateSequence = 0;
const dataFile = () => path.join(app.getPath('userData'), 'lokan.json');
const backupFile = () => path.join(app.getPath('userData'), 'lokan.backup.json');
const model = () => import('./model.mjs');

function checkSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Недопустимый источник запроса');
  }
}

async function readState() {
  const { createInitialState, normalizeState } = await model();
  for (const file of [dataFile(), backupFile()]) {
    try {
      const data = await fs.readFile(file, 'utf8');
      return { state: normalizeState(JSON.parse(data)), recovered: file === backupFile() };
    } catch (error) {
      if (error.code !== 'ENOENT' && file === backupFile()) {
        throw new Error(`Не удалось открыть данные: ${error.message}`);
      }
    }
  }
  return { state: createInitialState(), recovered: false };
}

async function writeState(raw) {
  const { normalizeState } = await model();
  const state = normalizeState(raw);
  const file = dataFile();
  const temp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.copyFile(file, backupFile()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  stateSequence++;
  return state;
}

function enqueueTask(action) {
  const task = saveQueue.catch(() => {}).then(action);
  saveQueue = task;
  return task;
}

function enqueueSave(state) { return enqueueTask(() => writeState(state)); }

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 800, minHeight: 560,
    backgroundColor: '#101319', title: 'LoKan',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webviewTag: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  Menu.setApplicationMenu(null);
  ipcMain.handle('data:load', async event => { checkSender(event); await saveQueue.catch(() => {}); return { ...await readState(), sequence: stateSequence }; });
  ipcMain.handle('data:apply', (event, action) => {
    checkSender(event);
    if (!action || typeof action !== 'object' || JSON.stringify(action).length > 50000) throw new Error('Invalid action');
    return enqueueTask(async () => {
      const { updateState } = await model();
      const { state } = await readState();
      const next = updateState(state, { ...action, actor: sync.config?.displayName || '' });
      if (next !== state) { await writeState(next); sync.changed(); }
      return { state: next, sequence: stateSequence };
    });
  });
  ipcMain.handle('data:export', async event => {
    checkSender(event);
    await saveQueue;
    const { state } = await readState();
    const result = await dialog.showSaveDialog(window, {
      title: state.language === 'en' ? 'Export LoKan data' : 'Экспорт данных LoKan', defaultPath: `LoKan-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('data:import', async event => {
    checkSender(event);
    await saveQueue.catch(() => {});
    const { state: current } = await readState();
    const result = await dialog.showOpenDialog(window, {
      title: current.language === 'en' ? 'Import LoKan data' : 'Импорт данных LoKan', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const { normalizeState } = await model();
    const data = await fs.readFile(result.filePaths[0], 'utf8');
    const state = normalizeState(JSON.parse(data));
    await enqueueSave(state);
    sync.changed();
    return state;
  });
  ipcMain.handle('data:path', event => { checkSender(event); return dataFile(); });
  ipcMain.handle('sync:status', event => { checkSender(event); return sync.publicStatus(); });
  ipcMain.handle('sync:probe', (event, options) => { checkSender(event); return sync.probe(options); });
  ipcMain.handle('sync:connect', (event, options) => { checkSender(event); return sync.configure(options); });
  ipcMain.handle('sync:disconnect', event => { checkSender(event); return sync.disconnect(); });
  ipcMain.handle('sync:now', event => { checkSender(event); return sync.run(); });
  ipcMain.handle('sync:key-file', event => { checkSender(event); return sync.chooseKey(window, dialog); });
  ipcMain.handle('sync:invite', async (event, name) => {
    checkSender(event);
    const code = await sync.createInvite(name);
    clipboard.writeText(code);
    return true;
  });
  ipcMain.handle('sync:invite-list', event => { checkSender(event); return sync.listInvites(); });
  ipcMain.handle('sync:revoke', (event, id) => { checkSender(event); return sync.revokeInvite(id); });
  ipcMain.handle('sync:join', (event, code, name) => { checkSender(event); return sync.joinInvite(code, name); });
  ipcMain.handle('cloud:start', async (event, url) => {
    checkSender(event);
    const result = await sync.beginCloud(url);
    await shell.openExternal(result.verificationUrl);
    return { code: result.code };
  });
  ipcMain.handle('cloud:poll', event => { checkSender(event); return sync.pollCloud(); });
  ipcMain.handle('mcp:status', async event => { checkSender(event); await mcpReady; return mcp.status(); });
  ipcMain.handle('mcp:configure', async (event, options) => { checkSender(event); await mcpReady; return mcp.configure(options); });
  ipcMain.handle('mcp:rotate', async event => { checkSender(event); await mcpReady; return mcp.rotate(); });
  ipcMain.handle('mcp:copy', async event => {
    checkSender(event);
    await mcpReady;
    const connection = mcp.connection();
    clipboard.writeText(JSON.stringify({ mcpServers: { lokan: { url: connection.url, headers: connection.headers } } }, null, 2));
    return true;
  });
  ipcMain.handle('link:open', async (event, value) => {
    checkSender(event);
    await saveQueue.catch(() => {});
    const { normalizeLink } = await model();
    if (typeof value !== 'string' || value.length > 2048 || normalizeLink(value) !== value) throw new Error('Invalid link');
    const { state } = await readState();
    if (!state.boards.some(board => board.cards.some(card => card.link === value))) throw new Error('Link not found');
    await shell.openExternal(value);
    return true;
  });
  createWindow();
  sync = new SyncService({
    userData: app.getPath('userData'), safeStorage,
    readLocal: readState, writeLocal: writeState, enqueueTask,
    notify: (channel, payload) => {
      if (window && !window.isDestroyed()) window.webContents.send(channel, channel === 'sync:state' ? { state: payload, sequence: stateSequence } : payload);
    }
  });
  sync.start().catch(() => {});
  mcpReady = import('./mcp_service.mjs').then(({ McpService }) => {
    mcp = new McpService({
      userData: app.getPath('userData'), readLocal: readState, writeLocal: writeState, enqueueTask,
      changed: () => sync.changed(),
      notify: state => {
        if (window && !window.isDestroyed()) window.webContents.send('sync:state', { state, sequence: stateSequence });
      }
    });
    return mcp.load();
  }).catch(error => console.error('MCP startup:', error));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { mcp?.stop().catch(() => {}); });
