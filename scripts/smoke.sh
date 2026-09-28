#!/usr/bin/env bash
# Post-deploy smoke test for a Cloudflare Pages preview.
# Asserts the deployed artifact actually boots and that runtime secrets/bindings
# are wired. Runs against preview only — never prod.
#
# Usage: scripts/smoke.sh <base-url>
#   e.g. scripts/smoke.sh https://fix-foo.nessebar-lens.pages.dev
#
# Exits 0 when every check passes, 1 otherwise. Prints one line per check.
set -uo pipefail

BASE="${1:-${SMOKE_BASE_URL:-}}"
if [[ -z "$BASE" ]]; then
  echo "usage: smoke.sh <base-url>" >&2
  exit 1
fi
BASE="${BASE%/}"

# Pages can be cold and freshly-synced secrets take a moment to propagate, so
# each check retries for ~60s before it is called a failure.
ATTEMPTS="${SMOKE_ATTEMPTS:-10}"
SLEEP="${SMOKE_SLEEP:-6}"

# Read the first catalog slug from photos.ts so the happy path can never
# drift away from the photos we actually ship.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALID_SLUG="$(sed -nE 's/^[[:space:]]*slug:[[:space:]]*"([a-z0-9-]+)",[[:space:]]*$/\1/p' \
  "$ROOT/src/lib/photos.ts" | head -1)"
if [[ -z "$VALID_SLUG" ]]; then
  echo "smoke: could not read a slug from src/lib/photos.ts" >&2
  exit 1
fi
BAD_SLUG="zzz-not-a-real-photo-slug"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

pass=0
fail=0

# check <name> <expected-status> <curl args...>
check() {
  local name="$1" expected="$2"
  shift 2
  local code="" attempt
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    code="$(curl -sS -o "$BODY" -w '%{http_code}' \
      --max-time 20 \
      --retry 2 --retry-delay 1 --retry-connrefused \
      "$@" 2>/dev/null)"
    code="${code//[!0-9]/}"
    [[ -n "$code" ]] || code=000
    if [[ "$code" == "$expected" ]]; then
      echo "smoke: PASS  $name (HTTP $code)"
      pass=$((pass + 1))
      return 0
    fi
    if ((attempt < ATTEMPTS)); then
      sleep "$SLEEP"
    fi
  done
  echo "smoke: FAIL  $name (expected $expected, got ${code:-000})"
  sed -e 's/^/smoke:        /' "$BODY" | head -5
  fail=$((fail + 1))
  return 1
}

# check_any <name> <expected statuses, space separated> <curl args...>
check_any() {
  local name="$1" expected="$2"
  shift 2
  local code="" attempt
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    code="$(curl -sS -o "$BODY" -w '%{http_code}' \
      --max-time 20 \
      --retry 2 --retry-delay 1 --retry-connrefused \
      "$@" 2>/dev/null)"
    code="${code//[!0-9]/}"
    [[ -n "$code" ]] || code=000
    for want in $expected; do
      if [[ "$code" == "$want" ]]; then
        echo "smoke: PASS  $name (HTTP $code)"
        pass=$((pass + 1))
        return 0
      fi
    done
    if ((attempt < ATTEMPTS)); then
      sleep "$SLEEP"
    fi
  done
  echo "smoke: FAIL  $name (expected one of: $expected, got ${code:-000})"
  sed -e 's/^/smoke:        /' "$BODY" | head -5
  fail=$((fail + 1))
  return 1
}

# check_body <name> <expected-status> <expected-substring> <curl args...>
check_body() {
  local name="$1" expected="$2" needle="$3"
  shift 3
  if check "$name" "$expected" "$@"; then
    if grep -qF -- "$needle" "$BODY"; then
      echo "smoke: PASS  ${name} body contains \"${needle}\""
      pass=$((pass + 1))
    else
      echo "smoke: FAIL  ${name} body missing \"${needle}\""
      sed -e 's/^/smoke:        /' "$BODY" | head -5
      fail=$((fail + 1))
    fi
  fi
}

echo "smoke: base=$BASE slug=$VALID_SLUG attempts=$ATTEMPTS"

# Public pages render.
for path in / /film /archive /fine-art /story; do
  check "GET $path" 200 "$BASE$path"
done

# Pre-rendered print detail: real slug serves, unknown slug 404s.
check "GET /prints/$VALID_SLUG" 200 "$BASE/prints/$VALID_SLUG"
check "GET /prints/<bad slug>" 404 "$BASE/prints/$BAD_SLUG"

# Body validation runs before any Prodigi call — deterministic, no network.
check_body "POST /api/quote invalid body" 400 "format must be" \
  -X POST -H 'Content-Type: application/json' -d '{"format":"poster","size":"30x40"}' \
  "$BASE/api/quote"

# Malformed session ids are rejected before KV is touched.
check_body "GET /api/download malformed session" 400 "invalid-session-id" \
  "$BASE/api/download?session_id=not-a-session"

# ORDERS bound: an unknown-but-valid session is still "processing" (202). A
# 503 means the KV binding is missing from the preview env, so it fails here.
check_any "GET /api/download unknown session" "202 503" \
  "$BASE/api/download?session_id=cs_test_smoke0001"

# HMAC guard: a 400 (not 503) means PRINT_ASSET_HMAC_SECRET is present in the
# preview env. Malformed exp fails the shape check before the expiry check.
check_body "GET /api/print-asset unsigned" 400 "invalid-exp" \
  "$BASE/api/print-asset?slug=$VALID_SLUG&exp=abc&sig=$(printf 'a%.0s' {1..64})"

echo "smoke: ${pass} passed, ${fail} failed"
((fail == 0))
