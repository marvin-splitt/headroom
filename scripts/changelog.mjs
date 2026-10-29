// Keeps CHANGELOG.md in step with releases.
//   node scripts/changelog.mjs release          files "Unreleased" under the version in package.json (`npm version` runs this)
//   node scripts/changelog.mjs notes <version>  prints the release notes for a version (the release workflow uses this;
//                                               HEADROOM_SIGNED=true drops the first-launch step for notarized builds)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, 'CHANGELOG.md');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = pkg.homepage;
let text = fs.readFileSync(file, 'utf8');

const fail = (msg) => { console.error(msg); process.exit(1); };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The body under "## [name]", up to the next heading or the link list at the bottom.
function section(name) {
  const m = new RegExp(`^## \\[${escape(name)}\\].*$`, 'm').exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const ends = [rest.search(/^## \[/m), rest.search(/^\[[^\]]+\]: /m)].filter((i) => i !== -1);
  return { heading: m.index, start, body: rest.slice(0, ends.length ? Math.min(...ends) : rest.length).trim() };
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'release') {
  const version = pkg.version;
  const unreleased = section('Unreleased');
  if (!unreleased) fail('CHANGELOG.md has no "## [Unreleased]" section.');
  if (!unreleased.body) fail('Nothing under "## [Unreleased]" in CHANGELOG.md. Write down what changed first.');
  if (section(version)) fail(`CHANGELOG.md already has a section for ${version}.`);

  const date = new Date().toISOString().slice(0, 10);
  text = text.replace(/^## \[Unreleased\].*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
  const prev = /^\[Unreleased\]: .*\/compare\/v(.+)\.\.\.HEAD$/m.exec(text)?.[1];
  const link = prev ? `${repo}/compare/v${prev}...v${version}` : `${repo}/releases/tag/v${version}`;
  text = text.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${link}`);
  fs.writeFileSync(file, text);
  console.log(`CHANGELOG.md: filed Unreleased under ${version}.`);
} else if (cmd === 'notes' && arg) {
  const notes = section(arg);
  if (!notes?.body) fail(`CHANGELOG.md has no notes for ${arg}.`);
  const firstLaunch = process.env.HEADROOM_SIGNED === 'true'
    ? ''
    : ` The first launch needs one extra step, see [Install](${repo}#install).`;
  console.log(`${notes.body}

---

**Which file?** \`${pkg.productName}-${arg}-arm64.dmg\` for Apple silicon Macs (M1 and later), \`${pkg.productName}-${arg}-x64.dmg\` for Intel Macs.
Open it and drag ${pkg.productName} to Applications.${firstLaunch}`);
} else {
  fail('Usage: node scripts/changelog.mjs release | notes <version>');
}
