import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME, run, duStream, exploreLimit, lstatSafe } from './util.js';
import { GROUPS, ITEMS, measureItem, simulators } from './scan.js';
import { runAction, moveToTrash, reveal, guardTrash, GuardError } from './actions.js';

const PACKAGE = /\.(app|xcarchive|photoslibrary|bundle|framework|pkg|plugin|kext|xcodeproj|xcworkspace|simruntime|sparsebundle|vmwarevm|pvm|utm)$/i;

/**
 * Everything the window can ask for. Streaming calls take an `emit(event, data)` callback.
 * The window only ever sends back entry ids from the last scan, never paths to delete.
 */
export function createCore({ dryRun = false } = {}) {
  // Latest scan per item: entry id → action.
  const scanned = new Map();
  // Explorer folder sizes, reused when you drill in and out.
  const sizeCache = new Map();

  function invalidateSizes(p) {
    for (const key of sizeCache.keys()) {
      if (key === p || key.startsWith(p + '/') || p.startsWith(key + '/')) sizeCache.delete(key);
    }
  }

  async function disk() {
    const st = await fs.statfs(HOME);
    const total = st.blocks * st.bsize;
    const strict = st.bavail * st.bsize;
    // Finder counts purgeable space as free; ask Foundation for the same number.
    const r = await run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', `
      ObjC.import("Foundation");
      const v = $.NSURL.fileURLWithPath(${JSON.stringify(HOME)}).resourceValuesForKeysError($(["NSURLVolumeAvailableCapacityForImportantUsageKey","NSURLVolumeTotalCapacityKey","NSURLVolumeNameKey"]), null);
      JSON.stringify({ free: ObjC.unwrap(v.objectForKey("NSURLVolumeAvailableCapacityForImportantUsageKey")), total: ObjC.unwrap(v.objectForKey("NSURLVolumeTotalCapacityKey")), name: ObjC.unwrap(v.objectForKey("NSURLVolumeNameKey")) })`], { timeout: 5000 });
    let fd = {};
    try { fd = JSON.parse(r.out); } catch {}
    return {
      name: fd.name || 'Macintosh HD',
      total: fd.total || total,
      free: fd.free || strict,
      purgeable: fd.free ? Math.max(0, fd.free - strict) : 0,
      home: HOME,
      dryRun,
    };
  }

  async function scan({ only } = {}, emit) {
    const items = only ? ITEMS.filter((x) => only.includes(x.id)) : ITEMS;
    emit('start', { groups: GROUPS, items: items.map(({ id, group, title, desc, suggested }) => ({ id, group, title, desc, suggested })) });
    await Promise.all(items.map(async (item) => {
      const { view, actions } = await measureItem(item);
      scanned.set(item.id, actions);
      emit('item', view);
    }));
    emit('done', {});
  }

  async function explore({ path: requested } = {}, emit, signal) {
    const dir = path.resolve(requested || HOME);
    const st = await lstatSafe(dir);
    if (!st?.isDirectory()) return emit('failed', { error: 'That folder doesn’t exist anymore.' });
    let list;
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return emit('failed', {
        error: e.code === 'EPERM' || e.code === 'EACCES' ? 'macOS blocks this folder.' : e.message,
        needsFullDiskAccess: e.code === 'EPERM' || e.code === 'EACCES',
      });
    }
    const items = await Promise.all(list.map(async (d) => {
      const p = path.join(dir, d.name);
      const s = await lstatSafe(p);
      const isDir = !!s?.isDirectory();
      return {
        name: d.name,
        path: p,
        kind: s?.isSymbolicLink() ? 'link' : isDir ? (PACKAGE.test(d.name) ? 'package' : 'folder') : 'file',
        bytes: !s ? 0 : isDir ? (sizeCache.get(p) ?? null) : s.isSymbolicLink() ? 0 : s.blocks * 512,
        mtime: s?.mtimeMs ?? 0,
      };
    }));
    emit('list', { path: dir, items });

    const pending = items.filter((x) => x.bytes === null);
    const store = (bytes, p) => sizeCache.set(p, bytes);
    if (pending.length > 300) {
      // Hundreds of subfolders (think node_modules): one pass beats hundreds of processes.
      await duStream(['-d', '1', '--', dir], (bytes, p) => {
        store(bytes, p);
        if (path.dirname(p) === dir) emit('size', { path: p, bytes });
      }, signal, exploreLimit);
    } else {
      // One du per folder, in parallel; -d 1 also caches the next level for when you drill in.
      await Promise.all(pending.map((x) => duStream(['-d', '1', '--', x.path], (bytes, p) => {
        store(bytes, p);
        if (p === x.path) emit('size', { path: p, bytes });
      }, signal, exploreLimit)));
    }
    for (const x of pending) if (!sizeCache.has(x.path)) emit('size', { path: x.path, bytes: 0 });
    emit('done', {});
  }

  async function clean({ selections = [] } = {}, emit) {
    const before = (await disk()).free;
    for (const { id, entries = [] } of selections) {
      const actions = scanned.get(id);
      if (!actions) { emit('item', { id, ok: false, error: 'Scan again before cleaning this.' }); continue; }
      emit('start', { id });
      let skipped = 0;
      const errors = [];
      for (const eid of entries) {
        const action = actions.get(eid);
        if (!action) { errors.push('Out of date, scan again.'); continue; }
        try {
          const r = await runAction(action, { dryRun });
          skipped += r.skipped;
        } catch (e) {
          errors.push(e instanceof GuardError ? `Skipped for safety: ${e.message}` : e.message);
        }
        emit('entry', { id, entry: eid });
      }
      emit('item', { id, ok: errors.length === 0, skipped, error: errors[0] });
    }
    sizeCache.clear();
    // APFS updates free space lazily; give it a moment before measuring.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await disk();
    emit('done', { freed: Math.max(0, after.free - before), disk: after, dryRun });
  }

  async function simAction(op, id) {
    const { devices, runtimes } = await simulators();
    let actions = [];
    if (op === 'erase' || op === 'delete') {
      const d = devices.find((x) => x.udid === id);
      if (!d) throw new Error('Simulator not found.');
      if (d.state === 'Booted') throw new Error(`Shut down ${d.name} first.`);
      actions = [{ type: op === 'erase' ? 'simErase' : 'simDelete', udid: d.udid }];
    } else if (op === 'deleteRuntime') {
      const rt = runtimes.find((x) => x.id === id);
      if (!rt) throw new Error('Runtime not found.');
      if (rt.running) throw new Error('A simulator on this runtime is running. Shut it down first.');
      // Simulators on a deleted runtime can't start anymore, so remove them with it.
      actions = [
        { type: 'runtimeDelete', id: rt.id },
        ...devices.filter((x) => x.runtimeId === rt.runtimeId).map((x) => ({ type: 'simDelete', udid: x.udid })),
      ];
    } else {
      throw new Error('Unknown action.');
    }
    for (const a of actions) await runAction(a, { dryRun });
    return { ok: true, dryRun };
  }

  async function trash(p) {
    await moveToTrash(p, { dryRun });
    invalidateSizes(p);
    return { ok: true, dryRun };
  }

  // Lets the UI refuse Move to Trash for protected folders before asking to confirm.
  function checkTrash(p) {
    try { guardTrash(p); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
  }

  return { disk, scan, explore, clean, sims: simulators, simAction, trash, reveal, checkTrash };
}
