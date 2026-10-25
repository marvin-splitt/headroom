import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { HOME, REAL_HOME, h, run, children, which, lstatSafe } from './util.js';

// Folders that are never deleted as a whole, even if a rule points at them.
const PROTECTED = new Set([
  HOME, 'Library', 'Library/Caches', 'Library/Application Support', 'Library/Containers',
  'Library/Group Containers', 'Library/Developer', 'Library/Developer/Xcode',
  'Library/Developer/CoreSimulator', 'Library/Developer/CoreSimulator/Devices', 'Library/Logs',
  'Library/Preferences', 'Library/Fonts', 'Library/Saved Application State', 'Desktop', 'Documents',
  'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', '.Trash', '.config',
  '.local', '.ssh', '.gnupg', '.aws', '.kube', '.docker',
].map((p) => (p === HOME ? HOME : h(p))));

// Nothing inside these is ever touched: credentials, iCloud, mail, messages, photos.
const FORBIDDEN = [
  'Library/Keychains', 'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Mail',
  'Library/Messages', 'Library/Photos', 'Library/Accounts', 'Library/Cookies', '.ssh', '.gnupg',
  '.aws', '.kube',
].map((p) => h(p));

const inside = (p, root) => p === root || p.startsWith(root + '/');

export class GuardError extends Error {}

function checkHomePath(p) {
  if (!p.startsWith(HOME + '/')) throw new GuardError(`Outside your home folder: ${p}`);
  if (PROTECTED.has(p)) throw new GuardError(`Protected folder: ${p}`);
  if (FORBIDDEN.some((f) => inside(p, f))) throw new GuardError(`Protected location: ${p}`);
}

/** Throws unless `p` is a concrete path inside the home folder that is safe to delete. */
export function guard(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || p.endsWith('/')) {
    throw new GuardError(`Refusing odd path: ${p}`);
  }
  checkHomePath(p);
  // A symlinked parent could redirect the delete somewhere else, so check where it really lands.
  let realParent;
  try { realParent = fss.realpathSync(path.dirname(p)); } catch { return; }
  if (!inside(realParent, REAL_HOME)) throw new GuardError(`Path resolves outside your home folder: ${p}`);
  checkHomePath(HOME + path.join(realParent, path.basename(p)).slice(REAL_HOME.length));
}

/** Explorer "Move to Trash": home contents or a top-level app in /Applications. */
export function guardTrash(p) {
  if (/^\/Applications\/[^/]+\.app$/.test(p) && path.normalize(p) === p) return;
  guard(p);
}

async function rmPaths(paths) {
  const failures = [];
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    batch.forEach(guard);
    const r = await run(['/bin/rm', '-rf', '--', ...batch], { timeout: 30 * 60_000 });
    if (r.code !== 0) failures.push(...r.err.split('\n').filter(Boolean));
  }
  return failures;
}

async function emptyDir(dir) {
  const st = await lstatSafe(dir);
  if (!st) return [];
  if (!st.isDirectory() || st.isSymbolicLink()) throw new GuardError(`Not a real folder: ${dir}`);
  const real = fss.realpathSync(dir);
  if (!dir.startsWith(HOME + '/') || !real.startsWith(REAL_HOME + '/') || FORBIDDEN.some((f) => inside(dir, f))) {
    throw new GuardError(`Protected location: ${dir}`);
  }
  const kids = await children(dir, { throwOnDenied: true });
  return rmPaths(kids.map((k) => k.path));
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

async function simctl(args) {
  const r = await run(['xcrun', 'simctl', ...args], { timeout: 10 * 60_000 });
  if (r.code !== 0) throw new Error(r.err.trim().split('\n').pop() || `simctl ${args[0]} failed`);
}

/** Runs one cleanup action. Returns { skipped } with the number of files that could not be removed. */
export async function runAction(a, { dryRun = false } = {}) {
  if (dryRun) {
    await new Promise((r) => setTimeout(r, 40));
    return { skipped: 0, dryRun: true };
  }
  let failures = [];
  switch (a.type) {
    case 'rm': failures = await rmPaths([a.path]); break;
    case 'rmMany': failures = await rmPaths(a.paths); break;
    case 'empty': failures = await emptyDir(a.path); break;
    case 'emptyMany':
      for (const p of a.paths) failures.push(...await emptyDir(p));
      break;
    case 'gradle':
      // A running daemon keeps handles into ~/.gradle/caches; stop it so the next build starts clean.
      await run(['/usr/bin/pkill', '-f', 'org.gradle.launcher.daemon'], { timeout: 10_000 });
      failures = await rmPaths(a.paths);
      break;
    case 'pnpmPrune': {
      const r = await run([which('pnpm') || 'pnpm', 'store', 'prune'], { timeout: 15 * 60_000 });
      if (r.code !== 0) throw new Error(r.err.trim().split('\n').pop() || 'pnpm store prune failed');
      break;
    }
    case 'docker': {
      const allowed = { builder: ['builder', 'prune', '-af'], images: ['image', 'prune', '-af'], containers: ['container', 'prune', '-f'] };
      if (!allowed[a.what]) throw new GuardError('Unknown Docker cleanup');
      const r = await run([which('docker') || 'docker', ...allowed[a.what]], { timeout: 15 * 60_000 });
      if (r.code !== 0) throw new Error(r.err.trim().split('\n').pop() || 'docker prune failed');
      break;
    }
    case 'simErase':
      if (!UDID.test(a.udid)) throw new GuardError('Bad simulator id');
      await simctl(['erase', a.udid]);
      break;
    case 'simDelete':
      if (!UDID.test(a.udid)) throw new GuardError('Bad simulator id');
      await simctl(['delete', a.udid]);
      break;
    case 'runtimeDelete':
      if (!UDID.test(a.id)) throw new GuardError('Bad runtime id');
      await simctl(['runtime', 'delete', a.id]);
      break;
    case 'finderEmptyTrash': {
      const r = await run(['/usr/bin/osascript', '-e', 'tell application "Finder" to empty trash'], { timeout: 10 * 60_000 });
      if (r.code !== 0) throw new Error('Finder could not empty the Trash. Allow automation for your terminal in System Settings → Privacy & Security.');
      break;
    }
    default:
      throw new GuardError(`Unknown action ${a.type}`);
  }
  return { skipped: failures.length };
}

export async function moveToTrash(p, { dryRun = false } = {}) {
  guardTrash(p);
  if (!(await lstatSafe(p))) throw new Error('That item no longer exists.');
  if (dryRun) return;
  const r = await run(['/usr/bin/trash', p], { timeout: 5 * 60_000 });
  if (r.code === 0) return;
  // Older macOS without /usr/bin/trash: move it into ~/.Trash ourselves.
  const base = path.basename(p);
  let target = path.join(HOME, '.Trash', base);
  for (let i = 2; await lstatSafe(target); i++) target = path.join(HOME, '.Trash', `${base} ${i}`);
  try {
    await fs.rename(p, target);
  } catch (e) {
    throw new Error(r.err.trim() || e.message);
  }
}

export async function reveal(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return;
  await run(['/usr/bin/open', '-R', p], { timeout: 10_000 });
}
