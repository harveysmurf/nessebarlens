#!/usr/bin/env bash
# Pages branch names: lowercase, alphanumeric + hyphen.
# Cloudflare truncates the branch alias at 28 characters, so the smoke
# test only finds the deployment if we truncate to the same limit --
# otherwise a longer branch name deploys fine and 404s on smoke.
# Cut first, then strip trailing hyphens: Cloudflare truncates and
# only then drops a trailing hyphen, so a 28-char prefix ending in "-"
# must not keep it here either or the alias gains a character.
set -euo pipefail

raw="${1:?usage: sanitize-branch-name.sh <branch-name>}"
echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g' | cut -c1-28 | sed -E 's/-+$//'
