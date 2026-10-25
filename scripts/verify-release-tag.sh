#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?usage: verify-release-tag.sh vX.Y.Z}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
ACTOR="${RELEASE_ACTOR:?RELEASE_ACTOR is required}"
OWNER="${REPOSITORY_OWNER:?REPOSITORY_OWNER is required}"
EXPECTED_FINGERPRINT="${RELEASE_SIGNER_FINGERPRINT:?RELEASE_SIGNER_FINGERPRINT is required}"

if [[ ! "$EXPECTED_FINGERPRINT" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]; then
  echo "::error::RELEASE_SIGNER_FINGERPRINT must be one complete SHA-256 fingerprint" >&2
  exit 1
fi

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Release tag must be vX.Y.Z, got: $TAG" >&2
  exit 1
fi

if [[ "$ACTOR" != "$OWNER" ]]; then
  echo "::error::Only the repository owner may authorize a release" >&2
  exit 1
fi

git fetch --force origin main "refs/tags/${TAG}:refs/tags/${TAG}"
REF_JSON="$(gh api "repos/${REPO}/git/ref/tags/${TAG}")"
if [[ "$(jq -r '.object.type' <<<"$REF_JSON")" != "tag" ]]; then
  echo "::error::${TAG} is not an annotated tag" >&2
  exit 1
fi

TAG_OBJECT="$(jq -r '.object.sha' <<<"$REF_JSON")"
TAG_JSON="$(gh api "repos/${REPO}/git/tags/${TAG_OBJECT}")"
if [[ "$(jq -r '.tag' <<<"$TAG_JSON")" != "$TAG" ]]; then
  echo "::error::Annotated tag object name does not match ${TAG}" >&2
  exit 1
fi
if [[ "$(jq -r '.verification.verified' <<<"$TAG_JSON")" != "true" ]]; then
  REASON="$(jq -r '.verification.reason // "unknown"' <<<"$TAG_JSON")"
  echo "::error::${TAG} does not have a GitHub-verified signature (${REASON})" >&2
  exit 1
fi

# GitHub's verified bit accepts any key trusted for the tagger account. Bind
# the release to the owner-approved hardware key as well. SSHSIG carries the
# public key fingerprint; check-novalidate verifies the payload signature but
# deliberately does not need an allowed_signers file because we compare the
# resulting fingerprint against the protected repository variable.
VERIFY_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/tokmeter-tag-verify.XXXXXX")"
trap 'rm -rf "$VERIFY_DIR"' EXIT
jq -jr '.verification.signature' <<<"$TAG_JSON" > "$VERIFY_DIR/signature"
jq -jr '.verification.payload' <<<"$TAG_JSON" > "$VERIFY_DIR/payload"
SIGNATURE_RESULT="$(ssh-keygen -Y check-novalidate -n git -s "$VERIFY_DIR/signature" < "$VERIFY_DIR/payload" 2>&1)" || {
  echo "::error::Release tag SSH signature could not be validated" >&2
  exit 1
}
ACTUAL_FINGERPRINT="$(grep -oE 'SHA256:[A-Za-z0-9+/]{43}' <<<"$SIGNATURE_RESULT" | tail -1)"
if [[ -z "$ACTUAL_FINGERPRINT" || "$ACTUAL_FINGERPRINT" != "$EXPECTED_FINGERPRINT" ]]; then
  echo "::error::Release tag was not signed by the approved hardware key" >&2
  exit 1
fi

COMMIT="$(jq -r '.object.sha' <<<"$TAG_JSON")"
git merge-base --is-ancestor "$COMMIT" origin/main || {
  echo "::error::${TAG} does not point to a commit on main" >&2
  exit 1
}

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "commit=${COMMIT}" >> "$GITHUB_OUTPUT"
fi

echo "Verified signed annotated tag ${TAG} on main."
