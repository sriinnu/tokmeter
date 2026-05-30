#!/usr/bin/env bash
#
# check-no-secrets.sh
#
# Hard gate against shipping a key/token/credential. `release.sh` runs this
# before committing AND before every publish stage; it is never skippable.
# Exits non-zero on the FIRST sign of a leak so a release aborts loudly.
#
# Checks, in order:
#   1. No secret-shaped FILE is tracked in git (.env.example is the only allowed
#      env-ish file).
#   2. Sensitive files present on disk are gitignored (can't be staged later).
#   3. No staged/committed file matches a secret VALUE pattern.
#   4. For each publishable npm package: nothing secret-shaped is in the pack
#      manifest, and the packed files contain no secret VALUE patterns.
#   5. Any built macOS bar zip contains no .env / Sparkle private key / *.p8.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Secret-shaped FILE names (basename match). .env.example is explicitly allowed.
NAME_RE='(^|/)\.env($|\.)|\.p8$|\.p12$|\.pem$|(^|/)sparkle_ed25519_priv$|sparkle_private_key|AuthKey[_A-Za-z0-9]*\.p8|(^|/)id_(rsa|ed25519)$|\.keystore$|\.key$'
# Secret VALUE patterns (file contents).
VALUE_RE='sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AuthKey_[A-Z0-9]{10}|aws_secret_access_key|APPLE_APP_PASSWORD=["'\'']?[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}'
# Allowlist: the detector itself holds these patterns as strings, and *.example
# files are placeholder templates by definition — neither is a leak.
ALLOW_RE='(^|/)check-no-secrets\.sh$|\.example$'

fail() { echo "  ✗ SECRET GUARD: $*" >&2; exit 1; }

echo "==> Secret guard"

# ── 1. No secret-shaped file tracked in git ──────────────────────────────────
tracked_bad="$(git ls-files | grep -nE "$NAME_RE" | grep -vE '(^|/)\.env\.example$' || true)"
if [[ -n "$tracked_bad" ]]; then
  echo "$tracked_bad" >&2
  fail "secret-shaped file(s) are tracked in git (above)."
fi
echo "  ✓ no secret-shaped files tracked"

# ── 2. Sensitive on-disk files are gitignored ────────────────────────────────
while IFS= read -r f; do
  [[ -e "$f" ]] || continue
  git check-ignore -q "$f" || fail "$f exists but is NOT gitignored — could be committed."
done < <(find . -path ./node_modules -prune -o -path ./.git -prune -o \
            \( -name '.env' -o -name '.env.*' ! -name '.env.example' \
               -o -name '*.p8' -o -name '*.p12' -o -name '*.pem' \
               -o -name 'sparkle_ed25519_priv' -o -name 'sparkle_private_key' \) -print 2>/dev/null)
echo "  ✓ on-disk sensitive files are all gitignored"

# ── 3. No staged file carries a secret VALUE ─────────────────────────────────
staged_hits=""
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  [[ "$f" =~ $ALLOW_RE ]] && continue
  if grep -IlE "$VALUE_RE" "$f" >/dev/null 2>&1; then staged_hits+="$f"$'\n'; fi
done < <(git diff --cached --name-only)
[[ -z "$staged_hits" ]] || { echo "$staged_hits" >&2; fail "staged file(s) contain a secret value (above)."; }
echo "  ✓ no staged file contains a secret value"

# ── 4. npm publish surface ───────────────────────────────────────────────────
for pj in packages/*/package.json; do
  node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).private?0:1)' "$pj" && continue
  pkgdir="$(dirname "$pj")"
  name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).name)' "$pj")"
  # Manifest of files that WOULD ship.
  files="$(cd "$pkgdir" && npm pack --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s)[0].files.forEach(f=>console.log(f.path))}catch(e){}})')"
  bad_names="$(echo "$files" | grep -nE "$NAME_RE" | grep -vE '\.env\.example$' || true)"
  [[ -z "$bad_names" ]] || { echo "$bad_names" >&2; fail "$name would publish secret-shaped file(s) (above)."; }
  # Content scan of the packed files.
  while IFS= read -r rel; do
    [[ -n "$rel" && -f "$pkgdir/$rel" ]] || continue
    grep -IlE "$VALUE_RE" "$pkgdir/$rel" >/dev/null 2>&1 && fail "$name would publish a secret value in $rel"
  done <<< "$files"
  echo "  ✓ $name pack surface clean ($(echo "$files" | grep -c . ) files)"
done

# ── 5. Built macOS bar zip(s) ────────────────────────────────────────────────
shopt -s nullglob
for zip in packages/macos-bar/TokmeterBar-*.zip; do
  inside="$(unzip -Z1 "$zip" 2>/dev/null | grep -nE "$NAME_RE" | grep -vE '\.env\.example$' || true)"
  [[ -z "$inside" ]] || { echo "$inside" >&2; fail "$zip contains a secret-shaped file (above)."; }
  echo "  ✓ $(basename "$zip") contains no secret-shaped files"
done
shopt -u nullglob

echo "==> Secret guard passed — nothing leaks."
