import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, h, run, which, sizeOf, children, isRealDir, lstatSafe, DAY } from './util.js';

export const GROUPS = [
  { id: 'caches', title: 'Caches and logs' },
  { id: 'dev', title: 'Xcode, simulators and Docker' },
  { id: 'projects', title: 'Inactive projects' },
  { id: 'files', title: 'Trash and downloads' },
];

const entryId = (action) => crypto.createHash('sha1').update(JSON.stringify(action)).digest('hex').slice(0, 12);

const GENERIC = new Set(['app', 'client', 'desktop', 'helper', 'mac', 'macos', 'osx', 'shipit', 'electron', 'browser', 'agent', 'beta', 'nightly']);
const TLDS = new Set(['com', 'org', 'io', 'net', 'dev', 'app', 'co', 'me', 'ai', 'us', 'de', 'uk', 'so', 'sh', 'tv', 'fm', 'is', 'cc']);
const KNOWN = { Code: 'VS Code', todesktop: 'Cursor', 'com.todesktop.230313mzl4w4u92': 'Cursor', ReactNative: 'React Native', ms: 'Microsoft' };

/** "com.spotify.client" → "Spotify", "dev.biomejs.biome" → "Biome". */
export function prettyName(name) {
  if (KNOWN[name]) return KNOWN[name];
  const parts = name.split('.');
  if (parts.length >= 2 && TLDS.has(parts[0].toLowerCase())) {
    const useful = parts.slice(1).filter((p) => !GENERIC.has(p.toLowerCase()) && !/\d{4,}/.test(p));
    const pick = useful[useful.length - 1] || parts[1];
    const label = KNOWN[pick] || pick;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return name;
}

async function pathEntries(list, suggested) {
  const existing = [];
  for (const e of list) if (await lstatSafe(e.path)) existing.push(e);
  const sizes = await sizeOf(existing.map((e) => e.path));
  return existing.map((e) => ({ ...e, bytes: sizes.get(e.path) || 0, checked: e.checked ?? suggested }));
}

async function folderChildrenEntries(root, { skip = () => false, label = (k) => k.name, suggested }) {
  const kids = (await children(root)).filter((k) => !k.isLink && !skip(k));
  const sizes = await sizeOf(kids.map((k) => k.path));
  return kids.map((k) => ({
    label: label(k),
    detail: label(k) !== k.name ? k.name : undefined,
    path: k.path,
    bytes: sizes.get(k.path) || 0,
    checked: suggested,
    action: k.isDir ? { type: 'empty', path: k.path } : { type: 'rm', path: k.path },
  }));
}

// ---------------------------------------------------------------------------
// Simulator data, shared with the Simulators tab.

const PLATFORM = {
  'com.apple.platform.iphonesimulator': 'iOS',
  'com.apple.platform.watchsimulator': 'watchOS',
  'com.apple.platform.appletvsimulator': 'tvOS',
  'com.apple.platform.xrsimulator': 'visionOS',
};

const runtimeLabel = (key) => {
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(key || '');
  return m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : key;
};

const versionKey = (v) => (v || '0').split('.').map((n) => n.padStart(4, '0')).join('.');

export async function simulators() {
  if (!which('xcrun')) return { available: false, devices: [], runtimes: [] };
  const [d, r] = await Promise.all([
    run(['xcrun', 'simctl', 'list', '-j', 'devices'], { timeout: 30_000 }),
    run(['xcrun', 'simctl', 'runtime', 'list', '-j'], { timeout: 30_000 }),
  ]);
  if (d.code !== 0) return { available: false, devices: [], runtimes: [] };
  const devices = [];
  for (const [runtimeId, list] of Object.entries(JSON.parse(d.out).devices || {})) {
    for (const x of list) {
      devices.push({
        udid: x.udid,
        name: x.name,
        runtimeId,
        runtime: runtimeLabel(runtimeId),
        state: x.state,
        available: x.isAvailable !== false,
        lastUsedAt: x.lastUsedAt || null,
        bytes: (x.dataPathSize || 0) + (x.logPathSize || 0),
        dataPath: x.dataPath,
      });
    }
  }
  // Older Xcode doesn't report sizes; measure the device folders instead.
  const unsized = devices.filter((x) => !x.bytes);
  if (unsized.length) {
    const dirs = unsized.map((x) => h('Library/Developer/CoreSimulator/Devices', x.udid));
    const sizes = await sizeOf(dirs);
    unsized.forEach((x, i) => { x.bytes = sizes.get(dirs[i]) || 0; });
  }
  let runtimes = [];
  if (r.code === 0) {
    runtimes = Object.values(JSON.parse(r.out)).map((x) => ({
      id: x.identifier,
      runtimeId: x.runtimeIdentifier,
      platform: PLATFORM[x.platformIdentifier] || 'Simulator',
      version: x.version,
      build: x.build,
      bytes: x.sizeBytes || 0,
      state: x.state,
      deletable: x.deletable !== false,
      lastUsedAt: x.lastUsedAt || null,
    }));
    const newest = {};
    for (const rt of runtimes) {
      if (!newest[rt.platform] || versionKey(rt.version) > versionKey(newest[rt.platform].version)) newest[rt.platform] = rt;
    }
    for (const rt of runtimes) {
      const users = devices.filter((x) => x.runtimeId === rt.runtimeId);
      rt.deviceCount = users.length;
      rt.running = users.some((x) => x.state === 'Booted');
      rt.newest = newest[rt.platform] === rt;
    }
  }
  return { available: true, devices, runtimes };
}

let simCache = null;
const sims = () => (simCache ??= simulators().finally(() => setTimeout(() => { simCache = null; }, 2000)));

const ago = (iso) => {
  if (!iso) return 'never opened';
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  if (days < 1) return 'used today';
  if (days < 2) return 'used yesterday';
  if (days < 14) return `last used ${days} days ago`;
  if (days < 60) return `last used ${Math.round(days / 7)} weeks ago`;
  return `last used ${Math.round(days / 30)} months ago`;
};

// ---------------------------------------------------------------------------
// Inactive projects: dependency and build folders nobody has touched in a while.

const STANDARD_HOME = new Set(['Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public']);
const HIDDEN_PROJECT_ROOTS = ['.t3/worktrees', '.codex/worktrees', '.cursor/worktrees', '.claude/worktrees'];
const ARTIFACTS = ['node_modules', 'Pods', '.next', '.turbo', 'target', 'build', 'DerivedData', '.gradle', '.build'];

async function has(dir, ...names) {
  for (const n of names) if (await lstatSafe(path.join(dir, n))) return true;
  return false;
}

async function isArtifact(p) {
  const name = path.basename(p);
  const parent = path.dirname(p);
  const parentName = path.basename(parent);
  switch (name) {
    case 'node_modules': case '.next': case '.turbo': return true;
    case 'Pods': return has(parent, 'Podfile');
    case 'target': return has(parent, 'Cargo.toml', 'pom.xml');
    case '.build': return has(parent, 'Package.swift');
    case 'build': return ['ios', 'android', 'app'].includes(parentName) || has(parent, 'build.gradle', 'build.gradle.kts');
    case 'DerivedData': return parentName === 'ios' || p.includes('/ios/');
    case '.gradle': return has(parent, 'gradlew', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts');
    default: return false;
  }
}

async function mtime(p) {
  const st = await lstatSafe(p);
  return st ? st.mtimeMs : 0;
}

/** Best guess at when someone last worked in a project. */
async function lastActivity(root) {
  const times = [await mtime(root)];
  for (const f of ['package.json', 'Podfile', 'Cargo.toml', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'bun.lock']) {
    times.push(await mtime(path.join(root, f)));
  }
  const gitPath = path.join(root, '.git');
  const git = await lstatSafe(gitPath);
  if (git?.isDirectory()) {
    times.push(await mtime(path.join(gitPath, 'index')), await mtime(path.join(gitPath, 'HEAD')));
  } else if (git?.isFile()) {
    times.push(git.mtimeMs);
    try {
      const gitdir = (await fs.readFile(gitPath, 'utf8')).match(/gitdir:\s*(.+)/)?.[1]?.trim();
      if (gitdir) times.push(await mtime(path.join(gitdir, 'index')), await mtime(path.join(gitdir, 'HEAD')));
    } catch {}
  }
  for (const k of await children(root)) {
    if (!ARTIFACTS.includes(k.name) && k.name !== '.git') times.push(await mtime(k.path));
  }
  return Math.max(...times);
}

async function projectRoot(dir, scanRoot) {
  let top = null;
  for (let cur = dir; cur.startsWith(scanRoot + '/'); cur = path.dirname(cur)) {
    if (await lstatSafe(path.join(cur, '.git'))) return cur;
    if (await lstatSafe(path.join(cur, 'package.json'))) top = cur;
  }
  return top || dir;
}

async function inactiveProjects() {
  const roots = [];
  for (const k of await children(HOME)) {
    if (k.isDir && !k.isLink && !k.name.startsWith('.') && !STANDARD_HOME.has(k.name)) roots.push(k.path);
  }
  for (const rel of HIDDEN_PROJECT_ROOTS) if (await isRealDir(h(rel))) roots.push(h(rel));
  if (!roots.length) return [];

  const nameTests = ARTIFACTS.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
  const r = await run([
    '/usr/bin/find', '-x', ...roots, '-maxdepth', '7',
    '(', '-name', '.git', '-o', '-name', 'Library', '-o', '-name', '.Trash', '-o', '-name', '*.app', ')', '-prune',
    '-o', '-type', 'd', '(', ...nameTests, ')', '-print', '-prune',
  ], { timeout: 180_000 });
  const found = r.out.split('\n').filter(Boolean);

  const projects = new Map();
  for (const p of found) {
    if (!(await isArtifact(p))) continue;
    const scanRoot = roots.find((x) => p.startsWith(x + '/'));
    const root = await projectRoot(path.dirname(p), scanRoot);
    if (!projects.has(root)) projects.set(root, []);
    projects.get(root).push(p);
  }

  const now = Date.now();
  const stale = [];
  for (const [root, paths] of projects) {
    const last = await lastActivity(root);
    const days = (now - last) / DAY;
    if (days >= 30) stale.push({ root, paths, days });
  }
  const entries = await Promise.all(stale.map(async ({ root, paths, days }) => {
    const sizes = await sizeOf(paths);
    const bytes = paths.reduce((s, p) => s + (sizes.get(p) || 0), 0);
    const kinds = [...new Set(paths.map((p) => path.relative(root, p)))];
    const idle = days < 60 ? `${Math.floor(days / 7)} weeks` : `${Math.floor(days / 30)} months`;
    return {
      label: path.relative(HOME, root),
      detail: `untouched for ${idle}, ${kinds.length === 1 ? kinds[0] : `${kinds.length} folders`}`,
      path: root,
      bytes,
      checked: days >= 90,
      action: { type: 'rmMany', paths },
    };
  }));
  return entries;
}

// ---------------------------------------------------------------------------
// Cleanup items. `suggested` items start selected; the rest need a look first.

const CARVED_CACHES = new Set(['Yarn', 'CocoaPods', 'Homebrew', 'ms-playwright']);
const CHROMIUM_MARKERS = ['GPUCache', 'Code Cache', 'DawnCache', 'DawnGraphiteCache'];
const WEB_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'CachedData', 'CachedExtensionVSIXs'];
const NO_DESCEND = new Set([...WEB_CACHE_DIRS, 'node_modules', 'IndexedDB', 'Local Storage', 'Session Storage', 'blob_storage', 'Service Worker', 'databases', 'vm_bundles', 'workspaceStorage', 'globalStorage', 'History', 'extensions']);

async function webCacheEntries() {
  const support = h('Library/Application Support');
  const apps = (await children(support)).filter((k) => k.isDir && !k.isLink && !k.name.startsWith('com.apple.') && k.name !== 'MobileSync');
  const entries = [];
  for (const app of apps) {
    const found = [];
    let visited = 0;
    const walk = async (dir, depth) => {
      if (visited++ > 400) return;
      const kids = await children(dir);
      const names = new Set(kids.map((k) => k.name));
      if (CHROMIUM_MARKERS.some((m) => names.has(m))) {
        for (const c of WEB_CACHE_DIRS) if (names.has(c)) found.push(path.join(dir, c));
      }
      if (depth >= 3) return;
      for (const k of kids) if (k.isDir && !k.isLink && !NO_DESCEND.has(k.name)) await walk(k.path, depth + 1);
    };
    await walk(app.path, 0);
    if (found.length) entries.push({ app, found });
  }
  const sizes = await sizeOf(entries.flatMap((e) => e.found));
  return entries.map(({ app, found }) => ({
    label: prettyName(app.name),
    detail: `${found.length} cache folder${found.length > 1 ? 's' : ''}`,
    path: app.path,
    bytes: found.reduce((s, p) => s + (sizes.get(p) || 0), 0),
    checked: true,
    action: { type: 'emptyMany', paths: found },
  }));
}

export const ITEMS = [
  {
    id: 'app-caches', group: 'caches', suggested: true,
    title: 'App caches',
    desc: 'Temporary files apps rebuild on their own, from browsers to Spotify.',
    measure: () => folderChildrenEntries(h('Library/Caches'), {
      suggested: true,
      label: (k) => prettyName(k.name),
      skip: (k) => CARVED_CACHES.has(k.name) || k.name === 'CloudKit' || (k.name.startsWith('com.apple.') && !k.name.startsWith('com.apple.dt.')),
    }),
  },
  {
    id: 'web-caches', group: 'caches', suggested: true,
    title: 'Web caches inside apps',
    desc: 'Cached pages and scripts in apps like Slack, Notion and VS Code. Quit them first for the cleanest result.',
    measure: webCacheEntries,
  },
  {
    id: 'yarn', group: 'caches', suggested: true,
    title: 'Yarn cache',
    desc: 'Downloaded packages. Yarn fetches them again when a project needs one.',
    measure: () => pathEntries([
      { label: 'Yarn cache', path: h('Library/Caches/Yarn'), action: { type: 'empty', path: h('Library/Caches/Yarn') } },
      { label: 'Yarn Berry cache', path: h('.yarn/berry/cache'), action: { type: 'empty', path: h('.yarn/berry/cache') } },
    ], true),
  },
  {
    id: 'npm', group: 'caches', suggested: true,
    title: 'npm cache',
    desc: 'Downloaded packages and npx tools. npm fetches them again on the next install.',
    measure: () => pathEntries(['_cacache', '_npx', '_logs'].map((n) => ({
      label: { _cacache: 'Package cache', _npx: 'npx downloads', _logs: 'Logs' }[n],
      path: h('.npm', n),
      action: { type: 'rm', path: h('.npm', n) },
    })), true),
  },
  {
    id: 'pnpm', group: 'caches', suggested: true, upTo: true,
    title: 'pnpm store',
    desc: 'Removes packages no project on this Mac still uses.',
    measure: async () => {
      if (!which('pnpm')) return [];
      const r = await run([which('pnpm'), 'store', 'path'], { timeout: 15_000 });
      const store = r.code === 0 ? r.out.trim() : '';
      if (!store || !(await isRealDir(store))) return [];
      return pathEntries([{ label: 'Unused packages in the store', path: store, action: { type: 'pnpmPrune' } }], true);
    },
  },
  {
    id: 'bun', group: 'caches', suggested: true,
    title: 'Bun cache',
    desc: 'Downloaded packages. Bun fetches them again on the next install.',
    measure: () => pathEntries([{ label: 'Install cache', path: h('.bun/install/cache'), action: { type: 'empty', path: h('.bun/install/cache') } }], true),
  },
  {
    id: 'cocoapods', group: 'caches', suggested: true,
    title: 'CocoaPods cache',
    desc: 'Downloaded pods. The next pod install fetches what it needs.',
    measure: () => pathEntries([{ label: 'Pod cache', path: h('Library/Caches/CocoaPods'), action: { type: 'empty', path: h('Library/Caches/CocoaPods') } }], true),
  },
  {
    id: 'homebrew', group: 'caches', suggested: true,
    title: 'Homebrew downloads',
    desc: 'Installer files Homebrew keeps after installing. Your installed tools stay.',
    measure: () => pathEntries([{ label: 'Download cache', path: h('Library/Caches/Homebrew'), action: { type: 'empty', path: h('Library/Caches/Homebrew') } }], true),
  },
  {
    id: 'gradle', group: 'caches', suggested: true,
    title: 'Gradle caches',
    desc: 'Android build dependencies. Running Gradle daemons are stopped first, and the next Android build downloads them again.',
    measure: async () => {
      const list = await pathEntries([
        { label: 'Dependency cache', path: h('.gradle/caches') },
        { label: 'Gradle versions', path: h('.gradle/wrapper/dists') },
        { label: 'Daemon logs', path: h('.gradle/daemon') },
      ], true);
      return list.map((e) => ({ ...e, action: { type: 'gradle', paths: [e.path] } }));
    },
  },
  {
    id: 'logs', group: 'caches', suggested: true,
    title: 'Logs and crash reports',
    desc: 'Diagnostic logs apps write over time. Nothing reads them unless you go looking.',
    measure: () => folderChildrenEntries(h('Library/Logs'), { suggested: true }),
  },
  {
    id: 'playwright', group: 'caches', suggested: false,
    title: 'Playwright browsers',
    desc: 'Browsers for end-to-end tests. Run npx playwright install to get them back.',
    measure: () => folderChildrenEntries(h('Library/Caches/ms-playwright'), { suggested: false })
      .then((list) => list.map((e) => ({ ...e, action: { type: 'rm', path: e.path } }))),
  },

  {
    id: 'derived-data', group: 'dev', suggested: true,
    title: 'Xcode build data',
    desc: 'DerivedData from past builds. Xcode recreates it on the next build.',
    measure: () => folderChildrenEntries(h('Library/Developer/Xcode/DerivedData'), {
      suggested: true,
      label: (k) => k.name.replace(/-[a-z]{28}$/, ''),
    }).then((list) => list.map((e) => ({ ...e, action: { type: 'rm', path: e.path } }))),
  },
  {
    id: 'device-support', group: 'dev', suggested: true,
    title: 'Device debug symbols',
    desc: 'Copied from iPhones and watches you plugged in. The newest version per platform stays; others come back if you reconnect that device.',
    measure: async () => {
      const out = [];
      for (const platform of ['iOS', 'watchOS', 'tvOS', 'visionOS']) {
        const dir = h(`Library/Developer/Xcode/${platform} DeviceSupport`);
        const kids = (await children(dir)).filter((k) => k.isDir && !k.isLink);
        if (!kids.length) continue;
        const withTime = await Promise.all(kids.map(async (k) => ({ k, t: await mtime(k.path) })));
        const newest = withTime.reduce((a, b) => (b.t > a.t ? b : a));
        const sizes = await sizeOf(kids.map((k) => k.path));
        for (const { k } of withTime) {
          out.push({
            label: k.name,
            detail: `${platform}${k === newest.k ? ', newest' : ''}`,
            path: k.path,
            bytes: sizes.get(k.path) || 0,
            checked: k !== newest.k,
            action: { type: 'rm', path: k.path },
          });
        }
      }
      return out;
    },
  },
  {
    id: 'old-runtimes', group: 'dev', suggested: true,
    title: 'Unused simulator runtimes',
    desc: 'Older iOS versions no simulator uses. Download them again from Xcode settings if you need one.',
    measure: async () => {
      const { runtimes } = await sims();
      return runtimes
        .filter((rt) => rt.deletable && rt.deviceCount === 0 && !rt.newest)
        .map((rt) => ({
          label: `${rt.platform} ${rt.version}`,
          detail: `Build ${rt.build}, ${rt.lastUsedAt ? ago(rt.lastUsedAt) : 'no simulators'}`,
          bytes: rt.bytes,
          checked: true,
          action: { type: 'runtimeDelete', id: rt.id },
        }));
    },
  },
  {
    id: 'idle-sims', group: 'dev', suggested: true,
    title: 'Idle simulators',
    desc: 'Simulators you haven’t opened in two weeks are reset. They stay in Xcode, just without apps and data.',
    measure: async () => {
      const { devices } = await sims();
      return devices
        .filter((x) => x.available && x.state === 'Shutdown' && x.bytes > 80e6 && (!x.lastUsedAt || Date.now() - Date.parse(x.lastUsedAt) > 14 * DAY))
        .map((x) => ({
          label: x.name,
          detail: `${x.runtime}, ${ago(x.lastUsedAt)}`,
          bytes: Math.max(0, x.bytes - 20e6),
          checked: true,
          action: { type: 'simErase', udid: x.udid },
        }));
    },
  },
  {
    id: 'unavailable-sims', group: 'dev', suggested: true,
    title: 'Broken simulators',
    desc: 'Simulators whose iOS version is no longer installed. They can’t start anyway.',
    measure: async () => {
      const { devices } = await sims();
      return devices.filter((x) => !x.available).map((x) => ({
        label: x.name, detail: x.runtime, bytes: x.bytes, checked: true, action: { type: 'simDelete', udid: x.udid },
      }));
    },
  },
  {
    id: 'sim-caches', group: 'dev', suggested: true,
    title: 'Simulator and preview caches',
    desc: 'Shared simulator caches and SwiftUI preview data. Rebuilt when needed.',
    measure: () => pathEntries([
      { label: 'Simulator caches', path: h('Library/Developer/CoreSimulator/Caches'), action: { type: 'empty', path: h('Library/Developer/CoreSimulator/Caches') } },
      { label: 'SwiftUI previews', path: h('Library/Developer/Xcode/UserData/Previews'), action: { type: 'empty', path: h('Library/Developer/Xcode/UserData/Previews') } },
    ], true),
  },
  {
    id: 'archives', group: 'dev', suggested: false,
    title: 'Xcode archives',
    desc: 'Builds you archived for the App Store. Keep the ones you may need to read crash reports from.',
    measure: async () => {
      const out = [];
      for (const day of (await children(h('Library/Developer/Xcode/Archives'))).filter((k) => k.isDir)) {
        for (const a of (await children(day.path)).filter((k) => k.name.endsWith('.xcarchive'))) {
          out.push({ label: a.name.replace(/\.xcarchive$/, ''), detail: day.name, path: a.path, action: { type: 'rm', path: a.path } });
        }
      }
      return pathEntries(out, false);
    },
  },
  {
    id: 'docker', group: 'dev', suggested: false,
    title: 'Docker leftovers',
    desc: 'Build cache, unused images and stopped containers. Volumes with data are never touched.',
    measure: async () => {
      if (!which('docker')) return [];
      const r = await run([which('docker'), 'system', 'df', '--format', '{{json .}}'], { timeout: 10_000 });
      if (r.code !== 0) return [];
      const parse = (s) => {
        const m = /([\d.]+)\s*([kKMGT]?B)/.exec(s || '');
        return m ? Number(m[1]) * ({ B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]] || 1) : 0;
      };
      const rows = r.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const pick = (type) => rows.find((x) => x.Type === type);
      return [
        { label: 'Build cache', what: 'builder', row: pick('Build Cache') },
        { label: 'Images no container uses', what: 'images', row: pick('Images') },
        { label: 'Stopped containers', what: 'containers', row: pick('Containers') },
      ].filter((x) => x.row).map((x) => ({
        label: x.label,
        detail: `${x.row.TotalCount} total, ${x.row.Active} in use`,
        bytes: parse(x.row.Reclaimable),
        checked: false,
        action: { type: 'docker', what: x.what },
      }));
    },
  },

  {
    id: 'stale-builds', group: 'projects', suggested: true,
    title: 'Dependencies in inactive projects',
    desc: 'node_modules, Pods and build folders in projects untouched for a month. Projects idle for 3+ months are selected. Reinstall when you come back.',
    measure: inactiveProjects,
  },

  {
    id: 'trash', group: 'files', suggested: true,
    title: 'Trash',
    desc: 'Files you already deleted. Emptying it is what actually frees the space.',
    measure: async () => {
      try {
        await children(h('.Trash'), { throwOnDenied: true });
      } catch {
        return [{ label: 'Trash', detail: 'Size unknown: give Headroom Full Disk Access to measure it', bytes: null, checked: false, action: { type: 'finderEmptyTrash' } }];
      }
      return pathEntries([{ label: 'Everything in the Trash', path: h('.Trash'), action: { type: 'empty', path: h('.Trash') } }], true);
    },
  },
  {
    id: 'installers', group: 'files', suggested: true,
    title: 'Installers in Downloads',
    desc: 'Disk images and packages you’ve likely installed already. Ones older than two weeks are selected.',
    measure: async () => {
      const kids = (await children(h('Downloads'))).filter((k) => /\.(dmg|pkg|mpkg|xip|iso)$/i.test(k.name));
      const list = await Promise.all(kids.map(async (k) => {
        const st = await lstatSafe(k.path);
        const age = (Date.now() - Math.max(st.birthtimeMs, st.mtimeMs)) / DAY;
        return { label: k.name, detail: age < 1 ? 'downloaded today' : `downloaded ${Math.round(age)} days ago`, path: k.path, checked: age > 14, action: { type: 'rm', path: k.path } };
      }));
      return pathEntries(list, false);
    },
  },
  {
    id: 'old-downloads', group: 'files', suggested: false,
    title: 'Large, old downloads',
    desc: 'Items over 100 MB in Downloads you haven’t changed in three months. Check before deleting.',
    measure: async () => {
      const kids = (await children(h('Downloads'))).filter((k) => !k.isLink && !/\.(dmg|pkg|mpkg|xip|iso)$/i.test(k.name));
      const old = [];
      for (const k of kids) {
        const st = await lstatSafe(k.path);
        if (st && Date.now() - st.mtimeMs > 90 * DAY) old.push({ k, st });
      }
      const sizes = await sizeOf(old.map((o) => o.k.path));
      return old
        .filter((o) => (sizes.get(o.k.path) || 0) >= 100e6)
        .map(({ k, st }) => ({
          label: k.name,
          detail: `changed ${Math.round((Date.now() - st.mtimeMs) / DAY / 30)} months ago`,
          path: k.path,
          bytes: sizes.get(k.path),
          checked: false,
          action: { type: 'rm', path: k.path },
        }));
    },
  },
  {
    id: 'ios-backups', group: 'files', suggested: false,
    title: 'iPhone and iPad backups',
    desc: 'Local device backups. Keep the latest unless you back up to iCloud.',
    measure: async () => {
      const root = h('Library/Application Support/MobileSync/Backup');
      const kids = (await children(root)).filter((k) => k.isDir);
      const list = await Promise.all(kids.map(async (k) => {
        const name = await run(['/usr/bin/plutil', '-extract', 'Device Name', 'raw', '-o', '-', path.join(k.path, 'Info.plist')], { timeout: 5000 });
        const st = await lstatSafe(k.path);
        return {
          label: name.code === 0 ? name.out.trim() : 'Device backup',
          detail: `backed up ${new Date(st.mtimeMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
          path: k.path,
          action: { type: 'rm', path: k.path },
        };
      }));
      return pathEntries(list, false);
    },
  },
];

/** Measures one item and returns the client view plus a private id → action map. */
export async function measureItem(item) {
  let entries = [];
  let error = null;
  try {
    entries = await item.measure();
  } catch (e) {
    error = e.message;
  }
  entries = entries
    .filter((e) => e.bytes === null || e.bytes > 0)
    .map((e) => ({ ...e, id: entryId(e.action) }))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  // A few kilobytes isn't worth a row; treat it as already clean.
  if (entries.every((e) => e.bytes !== null) && entries.reduce((s, e) => s + e.bytes, 0) < 1e6) entries = [];
  const actions = new Map(entries.map((e) => [e.id, e.action]));
  return {
    actions,
    view: {
      id: item.id,
      group: item.group,
      title: item.title,
      desc: item.desc,
      suggested: item.suggested,
      upTo: !!item.upTo,
      error,
      bytes: entries.reduce((s, e) => s + (e.bytes || 0), 0),
      entries: entries.map(({ action, ...rest }) => rest),
    },
  };
}
