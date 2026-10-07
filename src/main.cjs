const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.setName('LoKan');
app.setAppUserModelId('app.lokan.desktop');
app.disableHardwareAcceleration();
let window;
let saveQueue = Promise.resolve();
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
  return state;
}

function enqueueSave(state) {
  const task = saveQueue.catch(() => {}).then(() => writeState(state));
  saveQueue = task;
  return task;
}

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
  ipcMain.handle('data:load', async event => { checkSender(event); await saveQueue.catch(() => {}); return readState(); });
  ipcMain.handle('data:save', (event, state) => { checkSender(event); return enqueueSave(state); });
  ipcMain.handle('data:export', async event => {
    checkSender(event);
    await saveQueue;
    const result = await dialog.showSaveDialog(window, {
      title: 'Экспорт данных LoKan', defaultPath: `LoKan-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return false;
    const { state } = await readState();
    await fs.writeFile(result.filePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('data:import', async event => {
    checkSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: 'Импорт данных LoKan', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const { normalizeState } = await model();
    const data = await fs.readFile(result.filePaths[0], 'utf8');
    const state = normalizeState(JSON.parse(data));
    await enqueueSave(state);
    return state;
  });
  ipcMain.handle('data:path', event => { checkSender(event); return dataFile(); });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
