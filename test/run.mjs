// Runs the tests against a throwaway home folder. They delete files, so they must never see your real one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(dir, f));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-test-'));
fs.mkdirSync(path.join(root, 'home'));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, HOME: path.join(root, 'home'), HEADROOM_TEST_ROOT: root },
});
fs.rmSync(root, { recursive: true, force: true });
process.exit(r.status ?? 1);
