// Copies the built Headroom.app into /Applications, replacing an older Headroom build if there is one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const built = fs.readdirSync(dist)
  .map((d) => path.join(dist, d, 'Headroom.app'))
  .find((p) => fs.existsSync(p));
if (!built) throw new Error('No Headroom.app in dist/. Run `npm run build` first.');

const target = '/Applications/Headroom.app';
if (fs.existsSync(target)) {
  // Only replace our own app, never something else that happens to share the name.
  const id = spawnSync('/usr/bin/defaults', ['read', `${target}/Contents/Info.plist`, 'CFBundleIdentifier'], { encoding: 'utf8' }).stdout.trim();
  if (id !== pkg.build.appId) throw new Error(`${target} belongs to another app (${id || 'unknown'}). Move it away first.`);
  if (spawnSync('/usr/bin/pgrep', ['-f', `${target}/Contents/MacOS/`]).status === 0) throw new Error('Quit Headroom first.');
  fs.rmSync(target, { recursive: true });
}
const r = spawnSync('/usr/bin/ditto', [built, target], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Installed ${target}`);
