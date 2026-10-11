#!/usr/bin/env bash
#
# Run the user's global hook of the same name, if there is one.
#
# This repo sets core.hooksPath=.githooks for the tracked commit-msg hook.
# Git honours only ONE hooks path, so that setting silently switched off any
# global hooks (a pre-commit secret scanner, Git LFS). Each hook here calls
# this first so the global ones keep running.
#
# Usage (from a hook): "$(dirname "$0")/chain-global.sh" <hook-name> "$@"

name="$1"; shift
global="$(git config --global core.hooksPath 2>/dev/null || true)"
[ -n "$global" ] || exit 0
global="${global/#\~/$HOME}"
hook="$global/$name"
[ -x "$hook" ] || exit 0
# Don't recurse if the global path is this directory.
[ "$(cd "$global" && pwd -P)" = "$(cd "$(dirname "$0")" && pwd -P)" ] && exit 0
exec "$hook" "$@"
