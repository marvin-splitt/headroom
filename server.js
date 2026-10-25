#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOME, run, duStream, exploreLimit, lstatSafe } from './lib/util.js';
import { GROUPS, ITEMS, measureItem, simulators } from './lib/scan.js';
import { runAction, moveToTrash, reveal, guardTrash, GuardError } from './lib/actions.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const NO_OPEN = process.argv.includes('--no-open');
const START_PORT = Number(process.env.PORT) || 4823;
const TOKEN = crypto.randomBytes(16).toString('hex');

// Latest scan per item: entry id → action. The client only ever sends ids back.
const scanned = new Map();
// Explorer folder sizes, reused when you drill in and out.
const sizeCache = new Map();

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
  };
}

// ---------------------------------------------------------------------------

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

function events(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const ac = new AbortController();
  // Long du runs can leave the stream silent for a while; a comment line keeps it alive.
  const beat = setInterval(() => res.write(': still working\n\n'), 10_000);
  res.on('close', () => {
    clearInterval(beat);
    if (!res.writableEnded && process.env.HEADROOM_DEBUG) console.log(`client left early: ${req.url.split('?')[0]}`);
    ac.abort();
  });
  return {
    signal: ac.signal,
    emit: (event, data) => { if (!ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end: () => { clearInterval(beat); res.end(); },
  };
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function invalidateSizes(p) {
  for (const key of sizeCache.keys()) {
    if (key === p || key.startsWith(p + '/') || p.startsWith(key + '/')) sizeCache.delete(key);
  }
}

const PACKAGE = /\.(app|xcarchive|photoslibrary|bundle|framework|pkg|plugin|kext|xcodeproj|xcworkspace|simruntime|sparsebundle|vmwarevm|pvm|utm)$/i;

async function explore(req, res, url) {
  const dir = path.resolve(url.searchParams.get('path') || HOME);
  const st = await lstatSafe(dir);
  if (!st?.isDirectory()) return send(res, 404, { error: 'That folder doesn’t exist anymore.' });
  const { emit, end, signal } = events(req, res);
  let list;
  try {
    list = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    emit('failed', { error: e.code === 'EPERM' || e.code === 'EACCES'
      ? 'macOS blocks this folder. Give your terminal Full Disk Access in System Settings to look inside.'
      : e.message });
    return end();
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
  end();
}

async function scan(req, res, url) {
  const only = url.searchParams.get('only')?.split(',');
  const items = only ? ITEMS.filter((x) => only.includes(x.id)) : ITEMS;
  const { emit, end } = events(req, res);
  emit('start', { groups: GROUPS, items: items.map(({ id, group, title, desc, suggested }) => ({ id, group, title, desc, suggested })) });
  await Promise.all(items.map(async (item) => {
    const { view, actions } = await measureItem(item);
    scanned.set(item.id, actions);
    emit('item', view);
  }));
  emit('done', {});
  end();
}

async function clean(req, res) {
  const { selections = [] } = await body(req);
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const out = (o) => res.write(JSON.stringify(o) + '\n');
  const before = (await disk()).free;
  for (const { id, entries = [] } of selections) {
    const actions = scanned.get(id);
    if (!actions) { out({ type: 'item', id, ok: false, error: 'Scan again before cleaning this.' }); continue; }
    out({ type: 'start', id });
    let skipped = 0;
    const errors = [];
    for (const eid of entries) {
      const action = actions.get(eid);
      if (!action) { errors.push('Out of date, scan again.'); continue; }
      try {
        const r = await runAction(action, { dryRun: DRY_RUN });
        skipped += r.skipped;
      } catch (e) {
        errors.push(e instanceof GuardError ? `Skipped for safety: ${e.message}` : e.message);
      }
      out({ type: 'entry', id, entry: eid });
    }
    out({ type: 'item', id, ok: errors.length === 0, skipped, error: errors[0] });
  }
  sizeCache.clear();
  // APFS updates free space lazily; give it a moment before measuring.
  await new Promise((r) => setTimeout(r, 1500));
  const after = await disk();
  out({ type: 'done', freed: Math.max(0, after.free - before), disk: after, dryRun: DRY_RUN });
  res.end();
}

async function simAction(req, res) {
  const { op, id } = await body(req);
  const { devices, runtimes } = await simulators();
  let actions = [];
  if (op === 'erase' || op === 'delete') {
    const d = devices.find((x) => x.udid === id);
    if (!d) return send(res, 404, { error: 'Simulator not found.' });
    if (d.state === 'Booted') return send(res, 409, { error: `Shut down ${d.name} first.` });
    actions = [{ type: op === 'erase' ? 'simErase' : 'simDelete', udid: d.udid }];
  } else if (op === 'deleteRuntime') {
    const rt = runtimes.find((x) => x.id === id);
    if (!rt) return send(res, 404, { error: 'Runtime not found.' });
    if (rt.running) return send(res, 409, { error: 'A simulator on this runtime is running. Shut it down first.' });
    // Simulators on a deleted runtime can't start anymore, so remove them with it.
    actions = [
      { type: 'runtimeDelete', id: rt.id },
      ...devices.filter((x) => x.runtimeId === rt.runtimeId).map((x) => ({ type: 'simDelete', udid: x.udid })),
    ];
  } else {
    return send(res, 400, { error: 'Unknown action.' });
  }
  for (const a of actions) await runAction(a, { dryRun: DRY_RUN });
  send(res, 200, { ok: true, dryRun: DRY_RUN });
}

// ---------------------------------------------------------------------------

const STATIC = {
  '/app.js': ['public/app.js', 'text/javascript'],
  '/styles.css': ['public/styles.css', 'text/css'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

async function handle(req, res, port) {
  // Only answer to our own origin: blocks DNS rebinding and drive-by requests from other sites.
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://${host}`);

  if (url.pathname === '/') {
    const html = await fs.readFile(path.join(DIR, 'public/index.html'), 'utf8');
    return send(res, 200, html.replace('__TOKEN__', TOKEN).replace('__DRY__', String(DRY_RUN)), 'text/html; charset=utf-8');
  }
  if (STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, await fs.readFile(path.join(DIR, file)), type);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

  const token = req.headers['x-headroom-token'] || url.searchParams.get('t');
  if (token !== TOKEN) return send(res, 401, { error: 'Reload the page.' });
  const route = `${req.method} ${url.pathname}`;

  try {
    switch (route) {
      case 'GET /api/disk': return send(res, 200, { ...(await disk()), home: HOME, dryRun: DRY_RUN });
      case 'GET /api/scan': return await scan(req, res, url);
      case 'GET /api/explore': return await explore(req, res, url);
      case 'GET /api/sims': return send(res, 200, await simulators());
      case 'POST /api/clean': return await clean(req, res);
      case 'POST /api/sim': return await simAction(req, res);
      case 'POST /api/trash': {
        const { path: p } = await body(req);
        await moveToTrash(p, { dryRun: DRY_RUN });
        invalidateSizes(p);
        return send(res, 200, { ok: true, dryRun: DRY_RUN });
      }
      case 'POST /api/reveal': {
        const { path: p } = await body(req);
        await reveal(p);
        return send(res, 200, { ok: true });
      }
      case 'POST /api/check-trash': {
        // Lets the UI grey out the Trash button for protected folders before you click.
        const { path: p } = await body(req);
        try { guardTrash(p); return send(res, 200, { ok: true }); } catch (e) { return send(res, 200, { ok: false, reason: e.message }); }
      }
      default: return send(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    if (!res.headersSent) send(res, e instanceof GuardError ? 403 : 500, { error: e.message });
    else res.end();
  }
}

function listen(port, attempts = 10) {
  const server = http.createServer((req, res) => handle(req, res, port));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts > 1) listen(port + 1, attempts - 1);
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  Headroom is running at ${url}${DRY_RUN ? '  (dry run: nothing gets deleted)' : ''}\n  Press Ctrl+C to quit.\n`);
    if (!NO_OPEN) run(['/usr/bin/open', url]);
  });
}

listen(START_PORT);
