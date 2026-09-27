#!/usr/bin/env bash
# Flatten OpenNext output into a Cloudflare Pages upload directory.
# Usage: assemble-pages-out.sh [out-dir]
# Default out-dir: .pages-out (gitignored)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.open-next"
OUT="${1:-$ROOT/.pages-out}"

if [[ ! -f "$SRC/worker.js" ]]; then
  echo "missing $SRC/worker.js — run opennextjs-cloudflare build first" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
rsync -a --no-perms --no-owner --no-group "$SRC/" "$OUT/"
rsync -a --no-perms --no-owner --no-group "$SRC/assets/" "$OUT/"
rm -rf "$OUT/assets"
cp -f "$OUT/worker.js" "$OUT/_worker.js"

echo "assembled Pages out → $OUT"
