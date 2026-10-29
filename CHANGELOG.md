# Changelog

All notable changes to Headroom are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-29

First public release.

### Added

- **Clean up** measures app and web caches, package manager caches (Yarn, npm, pnpm, Bun, CocoaPods,
  Homebrew, Gradle), logs, Xcode build data and debug symbols, simulators and their runtimes, Docker
  leftovers, dependencies in inactive projects, the Trash, old installers in Downloads and iPhone backups.
  Safe items are selected for you; one button cleans the selection.
- **Explore** lists any folder by size, shows it in Finder or moves it to the Trash.
- **Simulators** erases or deletes simulators and old iOS runtimes. Running simulators and the runtimes they
  use are never touched.
- A dry run mode (`--dry-run`) that goes through every step without deleting anything.
- A guard that refuses to delete anything outside your home folder, through symlinks, or in protected
  places like Documents, Desktop, iCloud Drive, Mail, Photos and Keychains.

[Unreleased]: https://github.com/marvin-splitt/headroom/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/marvin-splitt/headroom/releases/tag/v1.0.0
