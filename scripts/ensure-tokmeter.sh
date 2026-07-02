#!/usr/bin/env bash
#
# ensure-tokmeter.sh — guarantee the @sriinnu/tokmeter meta-bundle is FRESH
# before the daemon/CLI run against it.
#
# The meta-package is a cp-bundle of core/cli/tui dist. The old guard only
# checked that the bundle EXISTED (`test -f`), so editing a core/cli/tui source
# left a stale bundle in place and the daemon/CLI silently ran old code — a
# recurring, hard-to-spot class of bug. This rebuilds whenever the bundle is
# missing OR any tracked source is newer than it.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE="packages/tokmeter/dist/core/index.js"

needs_build=0
if [[ ! -f "$BUNDLE" ]]; then
  needs_build=1
  reason="bundle missing"
elif [[ -n "$(find packages/core/src packages/cli/src packages/tui/src \
              -name '*.ts' -newer "$BUNDLE" -print -quit 2>/dev/null)" ]]; then
  needs_build=1
  reason="source newer than bundle"
fi

if [[ "$needs_build" == "1" ]]; then
  echo "==> tokmeter bundle ${reason} — rebuilding core + cli + tui + meta"
  bun run build:core && bun run build:cli && bun run build:tui && bun run build:tokmeter
fi
