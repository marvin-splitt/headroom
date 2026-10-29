## What and why

## Checklist

- [ ] `npm test` passes
- [ ] Tried it in the app with `npm run dry`
- [ ] CHANGELOG.md has an entry under Unreleased (if users will notice the change)

If this deletes anything:

- [ ] Deletes go through ids from the last scan and `guard()` in `lib/actions.js`
- [ ] New cleanup items are only pre-selected if they come back on their own and nothing is lost
- [ ] Tests cover what the guard must refuse or allow
