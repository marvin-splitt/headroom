import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adoptLoginShellPath } from '../lib/util.js';
import { createCore } from '../lib/core.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RENDERER = path.join(ROOT, 'renderer');
const DRY_RUN = process.argv.includes('--dry-run');
const FULL_DISK_ACCESS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const core = createCore({ dryRun: DRY_RUN });
let win = null;
let cleaning = 0;
// Disk calls wait for the login shell's PATH (pnpm, Docker); the window doesn't.
let pathReady = Promise.resolve();

if (!app.requestSingleInstanceLock()) app.quit();

// The window loads from app:// rather than file:// so it gets a real origin and a strict CSP.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveApp() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    const file = path.normalize(path.join(RENDERER, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (url.host !== 'headroom' || !file.startsWith(RENDERER + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---------- Calls from the window ----------

// Node reports custom schemes as origin "null", so compare scheme and host instead.
const fromApp = (e) => {
  try {
    const url = new URL(e.senderFrame.url);
    return url.protocol === 'app:' && url.host === 'headroom';
  } catch { return false; }
};

// Errors travel back as plain values so the window sees our message, not Electron's wrapper text.
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromApp(e)) return { error: 'Not allowed.' };
    await pathReady;
    try { return { value: await fn(...args) }; } catch (err) { return { error: err.message }; }
  });
}

handle('disk', () => core.disk());
handle('sims', () => core.sims());
handle('sim', (op, id) => core.simAction(op, id));
handle('trash', (p) => core.trash(p));
handle('reveal', (p) => core.reveal(p));
handle('check-trash', (p) => core.checkTrash(p));
handle('open-full-disk-access', () => shell.openExternal(FULL_DISK_ACCESS));

const STREAMS = {
  scan: (params, emit, signal) => core.scan({ only: Array.isArray(params.only) ? params.only : undefined }, emit, signal),
  explore: (params, emit, signal) => core.explore({ path: typeof params.path === 'string' ? params.path : '' }, emit, signal),
  clean: async (params, emit) => {
    cleaning++;
    try { await core.clean({ selections: Array.isArray(params.selections) ? params.selections : [] }, emit); } finally { cleaning--; }
  },
};
const streams = new Map();

ipcMain.on('stream:start', async (e, sid, kind, params) => {
  if (!fromApp(e) || !Object.hasOwn(STREAMS, kind) || typeof sid !== 'string') return;
  const ac = new AbortController();
  streams.set(sid, ac);
  const wc = e.sender;
  const emit = (event, data) => { if (!ac.signal.aborted && !wc.isDestroyed()) wc.send('stream', sid, event, data); };
  await pathReady;
  try {
    await STREAMS[kind](params && typeof params === 'object' ? params : {}, emit, ac.signal);
  } catch (err) {
    emit('error', { error: err.message });
  } finally {
    emit('end', {});
    streams.delete(sid);
  }
});

ipcMain.on('stream:cancel', (e, sid) => {
  if (fromApp(e)) streams.get(sid)?.abort();
});

const stopStreams = () => { for (const ac of streams.values()) ac.abort(); streams.clear(); };

// ---------- Window and menu ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Headroom',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171a' : '#e9ecef',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A reload or a closed window leaves nobody to report to, so stop measuring.
  win.webContents.on('did-start-navigation', (details) => { if (details.isMainFrame) stopStreams(); });
  win.on('close', (e) => {
    if (!cleaning) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Headroom is still cleaning.',
      detail: 'If you quit now, some of the selected items stay where they are.',
      buttons: ['Keep Cleaning', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { stopStreams(); win = null; });
  win.loadURL('app://headroom/');
}

const send = (cmd) => () => win?.webContents.send('menu', cmd);

function buildMenu() {
  const view = [
    { label: 'Scan Again', accelerator: 'CmdOrCtrl+R', click: send('rescan') },
    { type: 'separator' },
    { label: 'Clean Up', accelerator: 'CmdOrCtrl+1', click: send('tab:clean') },
    { label: 'Explore', accelerator: 'CmdOrCtrl+2', click: send('tab:explore') },
    { label: 'Simulators', accelerator: 'CmdOrCtrl+3', click: send('tab:sims') },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (!app.isPackaged) view.push({ role: 'toggleDevTools' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Full Disk Access Settings', click: () => shell.openExternal(FULL_DISK_ACCESS) },
        { type: 'separator' },
        { label: 'Headroom on GitHub', click: () => shell.openExternal(PKG.homepage) },
        { label: 'Report a Problem', click: () => shell.openExternal(PKG.bugs.url) },
      ],
    },
  ]));
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  pathReady = adoptLoginShellPath();
  serveApp();
  buildMenu();
  createWindow();
});
