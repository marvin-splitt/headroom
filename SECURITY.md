# Security

Headroom deletes files and may run with Full Disk Access, so security problems matter a lot here.

## Reporting a problem

Please don't open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/marvin-splitt/headroom/security/advisories/new)
and you'll get a reply as soon as possible. Once a fix is out, the report is published with credit to you,
unless you'd rather stay anonymous.

Examples of what counts:

- Getting Headroom to delete, or move to the Trash, anything it didn't show you, for example through
  symlinks, odd paths or timing.
- Code in the window reaching Node.js, the file system, or main process calls it shouldn't.
- Abusing Headroom's Full Disk Access from another program.

## Supported versions

Only the latest release gets security fixes.
