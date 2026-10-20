# shellcheck shell=bash
#
# Sourced by release.sh and update-brew-cask.sh.
#
# Commits and tags are signed with a hardware key that needs a physical tap,
# and one key serves every repo on the machine. When two signatures wait at
# once, the tap goes to whichever asked first and the other times out with
# "incorrect passphrase supplied to decrypt private key?". The 1.16.1 release
# died exactly that way: a commit in another repo was waiting on the key.
# These helpers wait for other signers to clear, then retry a missed tap
# instead of aborting the release.

# Pending signatures from any process: git runs `ssh-keygen -Y sign` for SSH
# keys and gpg for OpenPGP ones. Prints "pid  repo-dir" per signer.
other_signers() {
  local pid ppid dir
  for pid in $(pgrep -f 'ssh-keygen -Y sign|gpg .*(--sign|-bsau|--detach-sign)' 2>/dev/null); do
    # "|| true": callers run under set -e and pipefail, and the signer may
    # exit mid-lookup or lsof may be missing; a lookup must never end a release.
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    dir="$(lsof -a -p "${ppid:-$pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    printf '%s  %s\n' "$pid" "${dir:-unknown dir}"
  done
}

# Block until no other signature is pending, so the next tap is ours. Gives
# up after five minutes and signs anyway; the retry in `signed` covers that.
wait_for_key() {
  local waited=0 others
  while others="$(other_signers)"; [[ -n "$others" ]]; do
    if (( waited == 0 )); then
      echo "  ⚠ another signature is waiting for the key:"
      printf '%s\n' "$others" | sed 's/^/      /'
      echo "    Finish or cancel it — a tap goes to whichever asked first. Waiting…"
    fi
    if (( waited >= 300 )); then
      echo "  still pending after 300s; signing anyway."
      return 0
    fi
    sleep 3; waited=$((waited + 3))
  done
}

# signed <what> <command...> — run a signing command, retrying a missed tap.
signed() {
  local what="$1" attempt; shift
  for attempt in 1 2 3; do
    wait_for_key
    echo "  🔑 tap the key to sign the ${what}"
    "$@" && return 0
    echo "  signing the ${what} failed (attempt ${attempt}/3), usually a missed tap."
    if (( attempt < 3 )); then
      if [[ -t 0 ]]; then read -r -p "  press Enter to try again " _; else sleep 5; fi
    fi
  done
  return 1
}
