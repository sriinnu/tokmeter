#!/usr/bin/env bash
#
# bump-version.sh <X.Y.Z>
#
# Bump every in-repo version source in lockstep. Mechanical and
# offline — no git, no network, no signing. Safe to run anytime; `release.sh`
# calls it as its first stage, but you can run it standalone to stage a bump.
#
# Touches:
#   - all packages/*/package.json  "version" field
#   - packages/macos-bar/bundle.sh SHORT_VERSION default (+ bumps BUILD_VERSION)
#   - bun.lock                     workspace version metadata
#   - README.md                    release badge version
#   - CHANGELOG.md                 promotes [Unreleased], else inserts a dated skeleton
#   - packages/mcp/server.json     MCP registry manifest version
#
# The macOS bar BUILD_VERSION (CFBundleVersion) is monotonic — every run
# advances it by one so Sparkle always sees a higher build. That means running
# this twice for the same semver advances the build number twice; that's
# harmless (Sparkle compares build numbers, higher always wins).
#
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: bump-version.sh X.Y.Z" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Bumping all version sources to ${VERSION}"

# 1. package.json — replace only the package's own top-level "version" (the
#    first version-shaped field in the file; dependency pins use a caret and
#    aren't matched by the exact-semver pattern below).
for pj in packages/*/package.json; do
  perl -i -pe '
    if (!$done && s/"version":\s*"\d+\.\d+\.\d+"/"version": "'"$VERSION"'"/) { $done = 1 }
  ' "$pj"
  printf '    %-34s %s\n' "${pj#packages/}" "$(grep -m1 '"version"' "$pj" | tr -d ' ,')"
done

# Keep Bun's workspace metadata aligned; --lockfile-only can retain old versions.
if [[ -f "bun.lock" ]]; then
  perl -i -pe '
    $packages = 1 if /^  "packages":/;
    s/("version": ")[0-9.]+(")/${1}'"$VERSION"'${2}/ unless $packages;
  ' bun.lock
fi

# 2. macOS bar bundle.sh — SHORT_VERSION default + monotonic BUILD_VERSION.
BUNDLE="packages/macos-bar/bundle.sh"
if [[ -f "$BUNDLE" ]]; then
  perl -i -pe 's/(SHORT_VERSION="\$\{CFBundleShortVersionString:-)[0-9.]+(\}")/${1}'"$VERSION"'${2}/' "$BUNDLE"
  cur_build="$(grep -oE 'CFBundleVersion:-[0-9]+' "$BUNDLE" | grep -oE '[0-9]+' | head -1)"
  new_build="$(( cur_build + 1 ))"
  perl -i -pe 's/(CFBundleVersion:-)[0-9]+(\})/${1}'"$new_build"'${2}/' "$BUNDLE"
  echo "    bundle.sh  SHORT_VERSION=${VERSION}  BUILD_VERSION ${cur_build} -> ${new_build}"
fi

# 2b. packages/mcp/server.json — the MCP registry manifest. Both its own
#     `version` and the npm package version inside `packages[]` must equal the
#     release tag; the publish workflow refuses to register a mismatch.
SERVER_JSON="packages/mcp/server.json"
if [[ -f "$SERVER_JSON" ]]; then
  VERSION="$VERSION" node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.version = process.env.VERSION;
    for (const pkg of j.packages ?? []) pkg.version = process.env.VERSION;
    fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
  ' "$SERVER_JSON"
  echo "    server.json  version + package version -> ${VERSION}"
fi

# 3. README.md — release badge tracks the tag being cut.
README="README.md"
if [[ -f "$README" ]]; then
  perl -i -pe 's/(badge\/release-v)[0-9.]+(-)/${1}'"$VERSION"'${2}/' "$README"
  echo "    README.md  release badge -> v${VERSION}"
fi

# 4. CHANGELOG.md — promote [Unreleased] to this version if it exists; else
#    insert a dated skeleton above the newest release heading. Left alone if
#    this version is already present.
CHANGELOG="CHANGELOG.md"
if [[ -f "$CHANGELOG" ]] && grep -q "^## \[${VERSION}\]" "$CHANGELOG"; then
  echo "    CHANGELOG.md  [${VERSION}] already present — left as-is"
elif [[ -f "$CHANGELOG" ]] && grep -q "^## \[Unreleased\]" "$CHANGELOG"; then
  # Notes already written under Unreleased become this release's section.
  today="$(date +%F)"
  perl -i -pe 'if (/^## \[Unreleased\]/ && !$done++) { $_ = "## ['"$VERSION"'] - '"$today"'\n" }' "$CHANGELOG"
  echo "    CHANGELOG.md  [Unreleased] -> [${VERSION}] - ${today}"
elif [[ -f "$CHANGELOG" ]]; then
  today="$(date +%F)"
  # Insert before the first "## [" heading.
  perl -i -pe '
    if (!$ins && /^## \[/) {
      print "## ['"$VERSION"'] - '"$today"'\n\n### Added\n\n- _TODO_\n\n### Changed\n\n- _TODO_\n\n### Fixed\n\n- _TODO_\n\n";
      $ins = 1;
    }
  ' "$CHANGELOG"
  echo "    CHANGELOG.md  inserted [${VERSION}] - ${today} skeleton (fill it in)"
else
  echo "    CHANGELOG.md  not found — skipped"
fi

echo "==> Version bump complete. Review the diff before committing."
