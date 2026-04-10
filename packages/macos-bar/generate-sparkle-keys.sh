#!/usr/bin/env bash
# generate-sparkle-keys.sh — create an EdDSA keypair for Sparkle update signing.
#
# Sparkle 2.x uses EdDSA (ed25519) to sign update zips. Each update is signed
# with the PRIVATE key (kept secret on your release machine) and verified by
# the app using the PUBLIC key embedded in Info.plist (SUPublicEDKey).
#
# Output:
#   sparkle_ed25519_priv      # secret — KEEP OFF GITHUB, mode 0600
#   sparkle_ed25519_priv.pub  # base64 public key — paste into Info.plist
#                              # (bundle.sh reads it automatically if present)
#
# Run this ONCE per project. After that, keep the private key safe (1Password,
# encrypted backup) and never regenerate it — if you lose the private key,
# every existing user's auto-updates will fail forever because their app
# only trusts the original public key.

set -euo pipefail
cd "$(dirname "$0")"

PRIV="sparkle_ed25519_priv"
PUB="${PRIV}.pub"

if [[ -f "${PRIV}" ]]; then
    echo "ERROR: ${PRIV} already exists. Refusing to overwrite."
    echo "       If you really want a new keypair, move the existing one aside first."
    exit 1
fi

# Find Sparkle's generate_keys tool. Sparkle 2.5+ ships it as a binary
# artifact under .build/artifacts/sparkle/Sparkle/bin/. Older versions
# put it under .build/checkouts/Sparkle/bin/. Check both, then fall back
# to a generic find.
echo "==> Ensuring Sparkle SPM dependency is resolved (running swift build)"
swift build -c release >/dev/null 2>&1 || swift package resolve >/dev/null 2>&1 || true

GEN_TOOL=""
for candidate in \
    ".build/artifacts/sparkle/Sparkle/bin/generate_keys" \
    ".build/checkouts/Sparkle/bin/generate_keys"; do
    if [[ -x "${candidate}" ]]; then
        GEN_TOOL="${candidate}"
        break
    fi
done
if [[ -z "${GEN_TOOL}" ]]; then
    GEN_TOOL=$(find .build -name "generate_keys" -type f -perm +111 2>/dev/null | head -1)
fi
if [[ -z "${GEN_TOOL}" || ! -x "${GEN_TOOL}" ]]; then
    echo "ERROR: Sparkle's generate_keys tool not found."
    echo "       Run 'swift build -c release' once to fetch the SPM dependency, then re-run this."
    exit 2
fi
echo "==> Found generate_keys at: ${GEN_TOOL}"

echo "==> Generating ed25519 keypair via ${GEN_TOOL}"
"${GEN_TOOL}" > generate_keys.out 2>&1 || true

# generate_keys writes the private key to ~/Library/Application Support/...
# and prints the public key to stdout. We capture both into project-local files.
PUBLIC_KEY=$(grep -E '^[A-Za-z0-9+/=]{40,}$' generate_keys.out | tail -1 || true)

if [[ -z "${PUBLIC_KEY}" ]]; then
    echo "ERROR: could not extract public key from generate_keys output:"
    cat generate_keys.out
    rm -f generate_keys.out
    exit 3
fi

# Sparkle stores the private key in the macOS keychain. Export it so we have
# a portable copy under our control.
SECURITY_LABEL="https://sparkle-project.org"
PRIV_KEY=$(security find-generic-password -a "ed25519" -s "${SECURITY_LABEL}" -w 2>/dev/null || true)
if [[ -z "${PRIV_KEY}" ]]; then
    echo "WARNING: could not find private key in keychain at label '${SECURITY_LABEL}'"
    echo "         Sparkle will still work via the keychain, but you have no portable backup."
    echo "         Public key (paste into Info.plist SUPublicEDKey if needed):"
    echo "${PUBLIC_KEY}"
    rm -f generate_keys.out
    exit 0
fi

echo "${PRIV_KEY}" > "${PRIV}"
chmod 600 "${PRIV}"
echo "${PUBLIC_KEY}" > "${PUB}"
chmod 644 "${PUB}"
rm -f generate_keys.out

echo ""
echo "==> Generated Sparkle keypair"
echo "    Private:  ${PRIV} (mode 600 — DO NOT COMMIT)"
echo "    Public:   ${PUB}"
echo ""
echo "Public key (pasted into Info.plist SUPublicEDKey by bundle.sh):"
echo "${PUBLIC_KEY}"
echo ""
echo "Add to .gitignore:"
echo "    sparkle_ed25519_priv"
