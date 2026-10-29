// The window's only way to reach the disk. Everything goes through the main process, which
// validates ids and paths itself.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.error) throw new Error(r.error);
  return r.value;
}

const listeners = new Map();
let nextId = 0;
ipcRenderer.on('stream', (_e, sid, event, data) => {
  const fn = listeners.get(sid);
  if (!fn) return;
  if (event === 'end') listeners.delete(sid);
  fn(event, data);
});

/** Starts a long-running call. `onEvent(event, data)` gets progress; the returned function cancels it. */
function stream(kind, params, onEvent) {
  const sid = `s${++nextId}`;
  listeners.set(sid, onEvent);
  ipcRenderer.send('stream:start', sid, kind, params);
  return () => {
    listeners.delete(sid);
    ipcRenderer.send('stream:cancel', sid);
  };
}

contextBridge.exposeInMainWorld('headroom', {
  disk: () => call('disk'),
  sims: () => call('sims'),
  sim: (op, id) => call('sim', op, id),
  trash: (p) => call('trash', p),
  reveal: (p) => call('reveal', p),
  checkTrash: (p) => call('check-trash', p),
  openFullDiskAccess: () => call('open-full-disk-access'),
  scan: (only, onEvent) => stream('scan', { only }, onEvent),
  explore: (p, onEvent) => stream('explore', { path: p }, onEvent),
  clean: (selections, onEvent) => stream('clean', { selections }, onEvent),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
});
