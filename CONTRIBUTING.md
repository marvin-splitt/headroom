# Contributing to Headroom

Thanks for helping. The most useful contributions are new things to clean: a cache, a build folder, a
leftover from some tool. If you know one, open an issue with where it lives, what puts it there, and whether
it comes back on its own. Bug reports and pull requests are welcome too.

## Setup

You need macOS and Node.js 20 or later (`.nvmrc` has the version CI uses).

```sh
npm install
npm start       # run from source
npm run dry     # run without deleting anything
npm test
```

The README explains how the code is laid out.

## Ground rules

Headroom deletes files, so a few rules matter more than usual:

- **Never try deleting code against your own disk.** `npm test` runs against a throwaway home folder and
  refuses to run otherwise. `npm run dry` goes through the whole app without deleting anything.
- **Every delete goes through the scan.** The window sends ids from the last scan, never paths, and
  `lib/core.js` looks up what each id means. Every path is checked by `guard()` in `lib/actions.js`.
  Don't add a way around either.
- **Only pre-select what comes back on its own.** A cleanup item can be `suggested: true` when deleting it
  loses nothing the user would miss: caches, build output, downloaded dependencies. Anything else is
  `suggested: false`, which the app shows as *Review first*.
- **Test the guard.** If you change what the guard allows, add cases to `test/safety.test.mjs` for what it
  must still refuse.

## Code style

Plain JavaScript (ES modules), no framework and no build step for the window. Two-space indentation.
Comments explain why, not what. Keep messages in the app short and plain.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`.

## Pull requests

- Run `npm test` and try your change with `npm run dry`.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
- Keep pull requests small and focused on one thing.

## Releasing

Maintainers publish a release by pushing a version tag. The [Release workflow](.github/workflows/release.yml)
then builds Headroom for Apple silicon and Intel, runs the tests and publishes a GitHub release with the DMGs,
zips, checksums and the notes from the changelog. GitHub attaches the source code to every release.

1. Check that `## [Unreleased]` in CHANGELOG.md lists what changed.
2. Bump the version. This files the Unreleased notes under the new version, commits, and tags `vX.Y.Z`:

   ```sh
   npm version minor        # or patch, major
   ```

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

A version with a suffix, like `npm version prerelease --preid beta`, is published as a pre-release.

To check a build without publishing, run the Release workflow by hand (Actions → Release → Run workflow).
The DMGs are kept as a workflow artifact for 14 days.

### Signing and notarization

Without a certificate the app is signed ad hoc, and users have to allow it in Privacy & Security the first
time they open it. With an Apple Developer account, add these repository secrets and the workflow signs and
notarizes the app instead. If the certificate is there but the API key isn't, the build fails rather than
publish an app macOS would block.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Your *Developer ID Application* certificate and its private key, exported as .p12 and base64 encoded |
| `CSC_KEY_PASSWORD` | The password of that .p12 file |
| `APPLE_API_KEY` | The contents of an App Store Connect API *team* key (`AuthKey_….p8`) |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the list of team keys |

Set them from the terminal so the values never pass through a browser:

```sh
base64 -i developer-id.p12 | gh secret set CSC_LINK
gh secret set CSC_KEY_PASSWORD            # prompts for the value
gh secret set APPLE_API_KEY < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --body XXXXXXXXXX
gh secret set APPLE_API_ISSUER --body 00000000-0000-0000-0000-000000000000
```
