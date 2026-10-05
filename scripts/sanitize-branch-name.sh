#!/usr/bin/env bash
# Branch names: lowercase, alphanumeric + hyphen.
# Used to build the version tag on a PR preview (`pr-<number>-<branch>`), which
# the cleanup job on close matches by suffix, so both sides must derive the name
# the same way -- that is the whole contract of this script.
# The 28-character cap came from the Pages era, where Cloudflare truncated a
# branch alias at 28 characters and the smoke test then 404'd on a longer name.
# A Worker version has no alias, so the Pages-era reason for the 28-character
# cap is gone; the cap is left in place rather than removed here, because
# raising it changes the tags the cleanup job matches on and that wants its own
# smoke run. Cut first, then strip trailing hyphens: Cloudflare truncates and
# only then drops a trailing hyphen, so a prefix ending in "-" must not keep it
# here either.
set -euo pipefail

raw="${1:?usage: sanitize-branch-name.sh <branch-name>}"
echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g' | cut -c1-28 | sed -E 's/-+$//'
