# Headroom

A small local Mac cleaner. See what fills your disk, and clean the things that come back on their own.

## Start it

Double-click `Headroom.command`, or run:

```sh
node server.js            # opens http://127.0.0.1:4823
node server.js --dry-run  # everything works, nothing is deleted
```

Node 20+ is required. There are no dependencies.

For the Trash and iPhone backups to be measured, give your terminal app Full Disk Access
(System Settings → Privacy & Security → Full Disk Access).

## What it does

- **Clean up**: measures caches, simulators, old project dependencies and downloads. Safe items are selected
  for you; items marked *Review first* never are. One button cleans the selection.
- **Explore**: drill into any folder by size. Show it in Finder or move it to the Trash.
- **Simulators**: erase or delete simulators and old iOS runtimes.

## Safety

- The server only listens on 127.0.0.1, checks the Host header, and requires a per-launch token.
- The browser never sends paths to delete. It sends ids from the last scan, and the server looks up
  what each id means.
- Every delete is checked against a guard. It refuses anything outside your home folder, symlink tricks,
  and protected places: Documents, Desktop, iCloud Drive, Mail, Messages, Photos, Keychains, `.ssh`.
- Clean up deletes permanently, because that's what frees the space. Explore moves things to the Trash.
- Running simulators and the runtimes they use are never touched. Docker volumes are never touched.
