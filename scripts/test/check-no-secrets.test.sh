#!/usr/bin/env bash
#
# check-no-secrets.test.sh — verify scripts/check-no-secrets.sh catches modern
# provider/npm/GCP secret prefixes across tracked and staged files.
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null
export NPM_CONFIG_CACHE="$TMP/npm-cache"

pass=0; fail=0
ok()  { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

init_repo() {
  local dir="$TMP/repo-$1"
  rm -rf "$dir"
  mkdir -p "$dir/scripts" "$dir/packages/demo"
  cp "$SRC/scripts/check-no-secrets.sh" "$dir/scripts/check-no-secrets.sh"
  cat > "$dir/packages/demo/package.json" <<'EOF'
{"name": "demo-pkg", "version": "1.0.0"}
EOF
  printf 'export const ok = true;\n' > "$dir/packages/demo/index.js"
  git -C "$dir" init -q
  git -C "$dir" config user.name test
  git -C "$dir" config user.email test@example.com
  git -C "$dir" add -A
  git -C "$dir" -c commit.gpgsign=false commit -q -m "init"
  echo "$dir"
}

echo "check-no-secrets tests"

# Clean repo passes
clean_dir="$(init_repo clean)"
if (cd "$clean_dir" && bash scripts/check-no-secrets.sh >/dev/null 2>&1); then
  ok "passes on clean repository and clean npm pack surface"
else
  bad "passes on clean repository and clean npm pack surface"
fi

# Test modern secret patterns constructed dynamically so this file stays clean.
check_secret() {
  local name="$1" token="$2" mode="$3"
  local dir
  dir="$(init_repo "${name}-${mode}")"
  printf 'export const TOKEN = "%s";\n' "$token" > "$dir/packages/demo/leak.js"
  if [[ "$mode" == "tracked" ]]; then
    git -C "$dir" add packages/demo/leak.js
    git -C "$dir" -c commit.gpgsign=false commit -q -m "commit leak"
  else
    git -C "$dir" add packages/demo/leak.js
  fi
  if (cd "$dir" && bash scripts/check-no-secrets.sh >/dev/null 2>&1); then
    bad "rejects ${name} in ${mode} file"
  else
    ok "rejects ${name} in ${mode} file"
  fi
}

# Construct synthetic test tokens via runtime concatenation so this file never contains literal matches.
p_ant="sk""-ant-api03-""AAAABBBBCCCCDDDDEEEE"
p_proj="sk""-proj-""AAAABBBBCCCCDDDDEEEE1234"
p_npm="npm""_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
p_gcp="AI""zaSyAaBbCcDdEeFfGgHhIiJjKkLlMmNnOo123"

check_secret "sk-ant" "$p_ant" "tracked"
check_secret "sk-proj" "$p_proj" "staged"
check_secret "npm_token" "$p_npm" "tracked"
check_secret "AIza_gcp" "$p_gcp" "staged"

echo ""
echo "${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
