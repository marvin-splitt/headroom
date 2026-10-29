import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const HOME = os.homedir();
export const REAL_HOME = fss.realpathSync(HOME);
export const h = (...p) => path.join(HOME, ...p);

// Launched from Finder or a minimal shell, PATH may miss Homebrew and friends.
const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
export const ENV = {
  ...process.env,
  PATH: [...new Set([...(process.env.PATH || '').split(':'), ...extraPath])].filter(Boolean).join(':'),
};

export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export function run(argv, { timeout = 60_000, signal, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env: ENV, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: '', err: e.message });
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out, err });
    });
  });
}

const binCache = new Map();
export function which(bin) {
  if (binCache.has(bin)) return binCache.get(bin);
  let found = null;
  for (const dir of ENV.PATH.split(':')) {
    const p = path.join(dir, bin);
    try { fss.accessSync(p, fss.constants.X_OK); found = p; break; } catch {}
  }
  binCache.set(bin, found);
  return found;
}

/** An app opened from Finder gets a bare PATH. Borrow the one your login shell sets up (pnpm, nvm, Docker). */
export async function adoptLoginShellPath() {
  const shell = os.userInfo().shell || process.env.SHELL || '/bin/zsh';
  const r = await run([shell, '-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000 });
  const m = /__PATH__(.*?)__PATH__/s.exec(r.out);
  if (!m) return;
  ENV.PATH = [...new Set([...m[1].split(':'), ...ENV.PATH.split(':')])].filter(Boolean).join(':');
  binCache.clear();
}

// du is far faster than walking the tree in JS. Disk work goes through a
// small limiter so a scan doesn't thrash the SSD.
export const diskLimit = limiter(4);
// Explore gets its own lane so clicking around stays quick while a scan runs.
export const exploreLimit = limiter(3);

/** Streams `du` output line by line: onLine(bytes, path). */
export function duStream(args, onLine, signal, lane = diskLimit) {
  return lane(() => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const child = spawn('/usr/bin/du', ['-k', '-x', ...args], { env: ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort);
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const tab = line.indexOf('\t');
      if (tab > 0) onLine(Number(line.slice(0, tab)) * 1024, line.slice(tab + 1));
    });
    child.on('error', () => resolve());
    child.on('close', () => { signal?.removeEventListener('abort', onAbort); resolve(); });
  }));
}

/** Total allocated size for each path. Files via lstat, folders via du. */
export async function sizeOf(paths, signal) {
  const sizes = new Map();
  const dirs = [];
  await Promise.all(paths.map(async (p) => {
    try {
      const st = await fs.lstat(p);
      if (st.isDirectory()) dirs.push(p);
      else sizes.set(p, st.isSymbolicLink() ? 0 : st.blocks * 512);
    } catch { sizes.set(p, 0); }
  }));
  for (let i = 0; i < dirs.length; i += 40) {
    const batch = dirs.slice(i, i + 40);
    await duStream(['-s', '--', ...batch], (bytes, p) => sizes.set(p, bytes), signal);
  }
  for (const d of dirs) if (!sizes.has(d)) sizes.set(d, 0);
  return sizes;
}

export async function lstatSafe(p) {
  try { return await fs.lstat(p); } catch { return null; }
}

export async function isRealDir(p) {
  const st = await lstatSafe(p);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

/** Children of a folder, or [] when missing. Throws only on permission errors when asked to. */
export async function children(dir, { throwOnDenied = false } = {}) {
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    return list.map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      isDir: d.isDirectory(),
      isLink: d.isSymbolicLink(),
    }));
  } catch (e) {
    if (throwOnDenied && (e.code === 'EPERM' || e.code === 'EACCES')) throw e;
    return [];
  }
}

export const DAY = 86_400_000;
