// Builds a fake home folder, checks that the guard refuses dangerous paths, then runs a quick cleanup
// and checks that only caches and build output are gone. Run it with `npm test`, never directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.HEADROOM_TEST_ROOT;
const HOME = process.env.HOME;
if (
  !ROOT || !path.basename(ROOT).startsWith('headroom-test-') || HOME !== path.join(ROOT, 'home')
  || os.homedir() !== HOME || !fs.realpathSync(ROOT).startsWith(fs.realpathSync(os.tmpdir()) + '/')
) {
  throw new Error('Run this with `npm test`. It deletes files and must use a throwaway home folder.');
}
const OUTSIDE = path.join(ROOT, 'outside');

// Imported only after the check above, because lib/util.js reads HOME when it loads.
const { guard, guardTrash, runAction, GuardError } = await import('../lib/actions.js');
const { ITEMS, measureItem } = await import('../lib/scan.js');

const mk = (p, data = 'x'.repeat(1_200_000)) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const age = (p, days) => {
  const t = (Date.now() - days * 864e5) / 1000;
  fs.utimesSync(p, t, t);
};

mk(`${HOME}/Library/Caches/com.spotify.client/data/a.bin`);
mk(`${HOME}/Library/Caches/Yarn/v6/pkg.tgz`);
mk(`${HOME}/Library/Caches/com.apple.Safari/x`);
mk(`${HOME}/.npm/_cacache/index`);
mk(`${HOME}/Library/Logs/DiagnosticReports/crash.ips`);
mk(`${HOME}/Library/Application Support/Slack/Cache/data_1`);
mk(`${HOME}/Library/Application Support/Slack/Code Cache/js/1`);
mk(`${HOME}/Library/Application Support/Slack/GPUCache/g`);
mk(`${HOME}/Library/Application Support/Slack/IndexedDB/keep.db`);
mk(`${HOME}/dev/oldproj/package.json`, '{}');
mk(`${HOME}/dev/oldproj/node_modules/lib/index.js`);
mk(`${HOME}/dev/oldproj/src/app.js`);
mk(`${HOME}/dev/newproj/package.json`, '{}');
mk(`${HOME}/dev/newproj/node_modules/lib/index.js`);
mk(`${HOME}/Downloads/Thing.dmg`);
mk(`${HOME}/Documents/important.txt`, 'keep');
mk(`${OUTSIDE}/victim.txt`, 'keep');
fs.symlinkSync(HOME, `${HOME}/homelink`);
fs.symlinkSync(OUTSIDE, `${HOME}/outlink`);
fs.symlinkSync(OUTSIDE, `${HOME}/Library/Caches/EvilLink`);
for (const p of ['dev/oldproj', 'dev/oldproj/package.json', 'dev/oldproj/src', 'dev/oldproj/node_modules']) age(`${HOME}/${p}`, 120);
age(`${HOME}/Downloads/Thing.dmg`, 30);

test('guard refuses protected, odd and outside paths', () => {
  const refused = {
    'home itself': HOME,
    Library: `${HOME}/Library`,
    'Caches root': `${HOME}/Library/Caches`,
    Documents: `${HOME}/Documents`,
    unnormalized: `${HOME}/dev/../Documents`,
    'outside home': '/etc/hosts',
    'ssh key': `${HOME}/.ssh/id_rsa`,
    iCloud: `${HOME}/Library/Mobile Documents/x`,
    'symlink to home, then Library': `${HOME}/homelink/Library`,
    'symlink to home, then Documents': `${HOME}/homelink/Documents`,
    'symlink to outside': `${HOME}/outlink/victim.txt`,
  };
  for (const [name, p] of Object.entries(refused)) assert.throws(() => guard(p), GuardError, name);
});

test('guard allows cache folders and dependencies', () => {
  assert.doesNotThrow(() => guard(`${HOME}/Library/Caches/com.spotify.client`));
  assert.doesNotThrow(() => guard(`${HOME}/dev/oldproj/node_modules`));
});

test('guardTrash allows only top-level apps outside home', () => {
  assert.doesNotThrow(() => guardTrash('/Applications/Foo.app'));
  for (const p of ['/Applications', '/Applications/Foo.app/Contents', '/System/Library']) {
    assert.throws(() => guardTrash(p), GuardError, p);
  }
});

test('actions refuse the home folder and symlink tricks', async () => {
  await assert.rejects(runAction({ type: 'empty', path: HOME }), GuardError, 'empty home');
  await assert.rejects(runAction({ type: 'empty', path: `${HOME}/Library/Caches/EvilLink` }), GuardError, 'empty symlink');
  await assert.rejects(runAction({ type: 'rm', path: `${HOME}/outlink/victim.txt` }), GuardError, 'rm through symlink');
});

test('removing a symlink keeps its target', async () => {
  await runAction({ type: 'rm', path: `${HOME}/Library/Caches/EvilLink` });
  assert.ok(!fs.existsSync(`${HOME}/Library/Caches/EvilLink`));
  assert.ok(fs.existsSync(`${OUTSIDE}/victim.txt`));
});

test('scan picks the right entries', async () => {
  const views = {};
  for (const item of ITEMS) views[item.id] = (await measureItem(item)).view;
  assert.ok(!views['app-caches'].entries.some((e) => /Safari|Yarn/.test(e.detail || e.label)), 'skips Apple and Yarn caches');
  assert.deepEqual(views['stale-builds'].entries.map((e) => e.label), ['dev/oldproj'], 'lists only the old project');
  assert.ok(views['stale-builds'].entries[0].checked, 'old project is preselected');
});

test('quick cleanup removes caches and keeps everything else', async () => {
  const ids = ['app-caches', 'web-caches', 'yarn', 'npm', 'logs', 'stale-builds', 'installers'];
  for (const item of ITEMS.filter((x) => ids.includes(x.id))) {
    const { view, actions } = await measureItem(item);
    for (const e of view.entries) if (e.checked) await runAction(actions.get(e.id));
  }
  const gone = (p) => !fs.existsSync(p);
  const kept = (p) => fs.existsSync(p);
  assert.ok(kept(`${HOME}/Library/Caches/com.spotify.client`) && gone(`${HOME}/Library/Caches/com.spotify.client/data`), 'cache emptied, folder kept');
  assert.ok(kept(`${HOME}/Library/Caches/com.apple.Safari/x`), 'Apple cache untouched');
  assert.ok(gone(`${HOME}/Library/Caches/Yarn/v6`), 'Yarn cache emptied');
  assert.ok(gone(`${HOME}/Library/Application Support/Slack/Cache/data_1`), 'Slack cache emptied');
  assert.ok(kept(`${HOME}/Library/Application Support/Slack/IndexedDB/keep.db`), 'Slack data kept');
  assert.ok(gone(`${HOME}/dev/oldproj/node_modules`) && kept(`${HOME}/dev/oldproj/src/app.js`), 'old dependencies gone, source kept');
  assert.ok(kept(`${HOME}/dev/newproj/node_modules`), 'active project untouched');
  assert.ok(gone(`${HOME}/Downloads/Thing.dmg`), 'old installer removed');
  assert.ok(kept(`${HOME}/Documents/important.txt`), 'Documents kept');
  assert.ok(kept(`${OUTSIDE}/victim.txt`), 'files outside home kept');
});
