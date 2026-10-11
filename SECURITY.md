# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue or PR.

Use GitHub's private reporting:
[Report a vulnerability](https://github.com/sriinnu/tokmeter/security/advisories/new).
Only the maintainer sees the report.

Include what you can: the affected package and version, steps to reproduce,
and what an attacker gains. A proof of concept against your own machine is
welcome; please don't test against other people's.

You'll get an acknowledgement within a few days. Fixes ship in a patch
release, and the advisory is published once users can update.

## Supported versions

Only the latest release gets security fixes. Update with
`npm i -g @sriinnu/tokmeter@latest` and `@sriinnu/tokmeter-mcp@latest`; the
macOS app updates itself through Sparkle, or via `brew upgrade`.

## What is in scope

- `@sriinnu/tokmeter` (CLI, TUI, core) and `@sriinnu/tokmeter-mcp` (MCP
  server, daemon, statusline)
- The local daemon on `127.0.0.1:9877`: its token, Host and Origin checks
- Cleanup and restore: anything that deletes or writes outside the session
  roots tokmeter documents
- The macOS app and its update channel

Tokmeter reads session files that your own AI agents write. A malicious
transcript that makes tokmeter misreport a number is a bug; one that makes it
write, execute or send something is a vulnerability.
