# Headroom

A small Mac app that shows what fills your disk and cleans the things that come back on their own.

## Install

```sh
npm install
npm run install-app   # builds Headroom.app and copies it to /Applications
```

Then open Headroom from Launchpad or Spotlight. To build without installing, run `npm run build`; the app
lands in `dist/`.

For the Trash and iPhone backups to be measured, give Headroom Full Disk Access
(System Settings → Privacy & Security → Full Disk Access, or Help → Open Full Disk Access Settings).
The build is signed ad hoc, so macOS asks again after each rebuild.

## Develop

```sh
npm start       # run from source
npm run dry     # everything works, nothing is deleted
npm test
```

To try the installed app without deleting anything: `open -a Headroom --args --dry-run`.

## What it does

- **Clean up**: measures caches, simulators, old project dependencies and downloads. Safe items are selected
  for you; items marked *Review first* never are. One button cleans the selection.
- **Explore**: drill into any folder by size. Show it in Finder or move it to the Trash.
- **Simulators**: erase or delete simulators and old iOS runtimes.

## How it fits together

- `electron/main.js` runs the scanning and cleaning code (`lib/`) and opens the window.
- `electron/preload.cjs` is the window's only way to reach the disk: a short list of calls, no Node access.
- `public/` is the window itself, loaded from an `app://` scheme with a strict content security policy.

## Safety

- The window never sends paths to delete. It sends ids from the last scan, and the main process looks up
  what each id means.
- Every delete is checked against a guard. It refuses anything outside your home folder, symlink tricks,
  and protected places: Documents, Desktop, iCloud Drive, Mail, Messages, Photos, Keychains, `.ssh`.
- Clean up deletes permanently, because that's what frees the space. Explore moves things to the Trash.
- Running simulators and the runtimes they use are never touched. Docker volumes are never touched.
- Headroom may hold Full Disk Access, so the app binary can't be reused as a Node runtime or debugged
  through Node flags (Electron fuses), and the window runs sandboxed.

## Tests

```sh
npm test
```

The tests build a fake home folder in a temp directory, try to get the guard to delete things it
shouldn't, then run a quick cleanup and check that only caches and build output are gone. They also check
that a clean only acts on ids from the last scan. They refuse to run unless `npm test` has pointed `HOME`
at that temp folder.
