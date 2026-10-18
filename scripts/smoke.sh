#!/usr/bin/env bash
# Post-deploy smoke test.
# Asserts the deployed artifact actually boots and that runtime secrets/bindings
# are wired. Runs against a preview, against staging, and — since #200 — against
# production, where a failure triggers the release pipeline's rollback.
#
# Usage: scripts/smoke.sh <base-url>
#   e.g. scripts/smoke.sh https://staging.nessebarlens.com
#   or a PR preview's version URL, which has no stable alias
#
# Against the apex domain the caller must also pass SMOKE_ALLOW_PRODUCTION=1.
# The smoke reads only, so it is safe there, but "never pointed at prod by
# accident" is worth one line of ceremony: a mistyped base URL in a preview job
# is otherwise indistinguishable from a deliberate production check.
#
# SMOKE_EXPECTED_ORIGIN is the canonical origin the served pages must claim. It
# defaults to the base URL, which is right for staging, production and the local
# Worker, and wrong for a PR preview: a version URL has no alias, and the build
# carries the environment's NEXT_PUBLIC_SITE_URL, so a staging preview serves
# https://staging.nessebarlens.com inside /llms.txt no matter which version URL
# it is reached on. preview.yml passes it from the same secret the build used.
# SMOKE_FORBIDDEN_ORIGIN is the other environment's origin. It is derived from
# the expected one for the two hosts in wrangler.toml — the preview job needs it
# and has no second variable to read — and left empty for anything else
# (localhost, a version URL with no alias), where there is nothing to be wrong
# about and the check reports itself skipped rather than passing silently.
#
# Exits 0 when every check passes, 1 otherwise. Prints one line per check.
set -uo pipefail

BASE="${1:-${SMOKE_BASE_URL:-}}"
if [[ -z "$BASE" ]]; then
  echo "usage: smoke.sh <base-url>" >&2
  exit 1
fi
BASE="${BASE%/}"

# Unset falls back to the base URL; set-but-empty is an error rather than a
# silent fallback, because on a preview the two spellings differ and falling
# back would assert the version URL is canonical when the build never carried it.
if [[ -z "${SMOKE_EXPECTED_ORIGIN+x}" ]]; then
  EXPECTED_ORIGIN="$BASE"
elif [[ -z "$SMOKE_EXPECTED_ORIGIN" ]]; then
  echo "smoke: SMOKE_EXPECTED_ORIGIN is set but empty. NEXT_PUBLIC_SITE_URL never reached the build, so there is no origin to assert." >&2
  exit 1
else
  EXPECTED_ORIGIN="${SMOKE_EXPECTED_ORIGIN%/}"
fi

FORBIDDEN_ORIGIN="${SMOKE_FORBIDDEN_ORIGIN:-}"
if [[ -z "$FORBIDDEN_ORIGIN" ]]; then
  case "$EXPECTED_ORIGIN" in
    https://nessebarlens.com)         FORBIDDEN_ORIGIN=https://staging.nessebarlens.com ;;
    https://staging.nessebarlens.com) FORBIDDEN_ORIGIN=https://nessebarlens.com ;;
  esac
fi

# The host out of an origin, scheme, trailing slash and port all discarded. The
# cross-environment check matches on the host rather than on the full origin
# string, so the scheme is dropped deliberately: a build that leaks the other
# environment into a `http://` URL or a protocol-relative `//host/path` is just as
# wrong as one that leaks an `https://` one, and a full-origin grep misses both.
origin_host() {
  local o="${1#*://}"
  o="${o%%/*}"
  o="${o%%:*}"
  printf '%s' "$o"
}

if [[ "$BASE" == "https://nessebarlens.com" && "${SMOKE_ALLOW_PRODUCTION:-}" != "1" ]]; then
  echo "smoke: refusing to smoke $BASE without SMOKE_ALLOW_PRODUCTION=1" >&2
  exit 1
fi

# A cold Worker and freshly-attached secrets both take a moment to serve, so
# each check retries for ~60s before it is called a failure.
ATTEMPTS="${SMOKE_ATTEMPTS:-10}"
SLEEP="${SMOKE_SLEEP:-6}"

# Read a catalog slug from content/photos so the happy path can never drift
# away from the photos we actually ship. The filename is the slug (the schema
# requires any `slug:` in the file to equal it), and every committed photo is
# published, so the first file is a real, served slug.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALID_SLUG=""
for f in "$ROOT"/content/photos/*.yaml; do
  [[ -e "$f" ]] || break
  VALID_SLUG="${f##*/}"
  VALID_SLUG="${VALID_SLUG%.yaml}"
  break
done
if [[ -z "$VALID_SLUG" ]]; then
  echo "smoke: could not read a slug from content/photos/*.yaml" >&2
  exit 1
fi
BAD_SLUG="zzz-not-a-real-photo-slug"

# A browser-like request. Cloudflare's automatic Web Analytics injection only
# fires for browser-like user agents, so every beacon check in this file used to
# read a body that curl had fetched: the injected snippet was never in it. That is
# why "no matches for cloudflareinsights" was believed while a second beacon was
# serving every visitor, and a guard that cannot see the thing it guards is the
# fragile-measurement mistake in a different costume.
BROWSER_HEADERS=(
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
)

BODY="$(mktemp)"
HEADERS="$(mktemp)"
trap 'rm -f "$BODY" "$HEADERS"' EXIT

pass=0
fail=0

# A failing check quotes what it fetched, capped per line: /sitemap.xml is one
# line of XML and an uncapped dump buries the one check name in a wall of <loc>.
dump_body() {
  sed -e 's/^/smoke:        /' "$BODY" | cut -c1-200 | head -5
}

# check <name> <expected-status> <curl args...>
check() {
  local name="$1" expected="$2"
  shift 2
  local code="" attempt
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    code="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' \
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
  dump_body
  fail=$((fail + 1))
  return 1
}

# check_any <name> <expected statuses, space separated> <curl args...>
check_any() {
  local name="$1" expected="$2"
  shift 2
  local code="" attempt
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    code="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' \
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
  dump_body
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
      dump_body
      fail=$((fail + 1))
    fi
  fi
}

# check_body_forbids_host <name> <expected-status> <forbidden-origin> <curl args...>
check_body_forbids_host() {
  local name="$1" expected="$2" origin="$3"
  shift 3
  local host pattern
  host="$(origin_host "$origin")"
  # Match the host only where it IS the host: not preceded by a dot, a dash or a
  # letter — that is `staging.` in front of `nessebarlens.com`, i.e. the
  # *correct* environment — and not followed by one, that is a longer domain
  # wearing this one as a prefix. A bare substring match gets both wrong: on a
  # staging body it fails a build that is right, and on a production body a
  # `https://nessebarlens.com.elsewhere.example` link would read as a leak.
  pattern="(^|[^[:alnum:]._-])${host//./\\.}([^[:alnum:]._-]|\$)"
  if check "$name" "$expected" "$@"; then
    if grep -Eq -- "$pattern" "$BODY"; then
      # The offending lines, not just the verdict: "forbidden origin present"
      # with no match costs another archaeology session on a body that is
      # otherwise a wall of prose.
      echo "smoke: FAIL  ${name} body names \"${host}\", which belongs to ${origin}"
      grep -E -- "$pattern" "$BODY" | head -3 | cut -c1-200 | sed -e 's/^/smoke:        /'
      fail=$((fail + 1))
    else
      echo "smoke: PASS  ${name} body omits the host \"${host}\" (from ${origin})"
      pass=$((pass + 1))
    fi
  fi
}

# check_header <name> <expected-status> <expected-substring> <curl args...>
check_header() {
  local name="$1" expected="$2" needle="$3"
  shift 3
  if check "$name" "$expected" "$@"; then
    # Case-insensitive: curl writes the header name as the server sent it, and
    # the same header arrives capitalised from a Node origin and lowercase over
    # HTTP/2 depending on the hop.
    if grep -qiF -- "$needle" "$HEADERS"; then
      echo "smoke: PASS  ${name} response headers contain \"${needle}\""
      pass=$((pass + 1))
    else
      echo "smoke: FAIL  ${name} response headers missing \"${needle}\""
      tr -d '\r' < "$HEADERS" | sed -e 's/^/smoke:        /' | cut -c1-200 | head -8
      fail=$((fail + 1))
    fi
  fi
}

# check_csp_directive <name> <expected-status> <directive> <expected-substring> <curl args...>
check_csp_directive() {
  local name="$1" expected="$2" directive="$3" needle="$4"
  shift 4
  if check "$name" "$expected" "$@"; then
    local policy part
    policy="$(tr -d '\r' < "$HEADERS" | grep -i '^content-security-policy:' | head -1)"
    policy="${policy#*: }"
    # One directive, not the whole policy: `connect-src` naming the RUM origin
    # is the assertion, and a substring search over the whole value would be
    # satisfied by `script-src` carrying the same host.
    part="$(printf '%s' "$policy" | tr ';' '\n' \
      | grep -E "^[[:space:]]*${directive}([[:space:]]|$)" | head -1)"
    if [[ -z "$policy" ]]; then
      echo "smoke: FAIL  ${name} served no Content-Security-Policy"
      fail=$((fail + 1))
    elif [[ -z "$part" ]]; then
      echo "smoke: FAIL  ${name} CSP declares no ${directive}"
      printf 'smoke:        %s\n' "$policy"
      fail=$((fail + 1))
    elif printf '%s' "$part" | grep -qF -- "$needle"; then
      echo "smoke: PASS  ${name} CSP ${directive} contains \"${needle}\""
      pass=$((pass + 1))
    else
      echo "smoke: FAIL  ${name} CSP ${directive} missing \"${needle}\""
      printf 'smoke:        %s\n' "$part"
      fail=$((fail + 1))
    fi
  fi
}

# check_one_beacon <name> <expected-status> <curl args...>
# Exactly one beacon in the body, and no script tag loading one.
#
# Two assertions because no single substring can carry it. `beacon.min.js`
# occurs TWICE for one correct beacon — Next emits a preload link and an RSC
# payload entry for the same `afterInteractive` script — so counting the src
# over-counts by one per beacon, and "exactly one src" would fail the healthy
# build on every deploy. `data-cf-beacon` occurs once per instance, whoever
# wrote it. And because our own beacon is `afterInteractive`, Next never writes
# a literal `<script>` tag for it: any beacon script tag in the served HTML was
# put there by something else. The second assertion catches an injector that
# writes only a script tag, which the first cannot see.
check_one_beacon() {
  local name="$1" expected="$2"
  shift 2
  local instances scripts
  if ! check "$name" "$expected" "$@"; then
    return 1
  fi
  instances="$(grep -o 'data-cf-beacon' "$BODY" | wc -l | tr -d '[:space:]')"
  scripts="$(grep -oE '<script[^>]*beacon\.min\.js' "$BODY" | wc -l | tr -d '[:space:]')"

  if [[ "$instances" -lt 1 ]]; then
    echo "smoke: FAIL  ${name} body carries no beacon at all, expected 1"
    fail=$((fail + 1))
    return 1
  fi
  if [[ "$instances" -ne 1 ]]; then
    # Two beacons collide: the first one to run seeds window.__cfBeacon and the
    # second merges into it, which drops `send.to` and sends nothing at all.
    # Every other check in this file stays green through that, so it has to be
    # caught here or not at all.
    echo "smoke: FAIL  ${name} body carries ${instances} beacons, expected 1"
    grep -oE '.{0,90}data-cf-beacon.{0,150}' "$BODY" | head -4 | cut -c1-200 | sed -e 's/^/smoke:        /'
    fail=$((fail + 1))
    return 1
  fi
  if [[ "$scripts" -ne 0 ]]; then
    echo "smoke: FAIL  ${name} body loads the beacon from ${scripts} script tag(s); this site's own beacon is afterInteractive and renders none"
    grep -oE '<script[^>]*beacon\.min\.js[^>]*>' "$BODY" | head -3 | cut -c1-200 | sed -e 's/^/smoke:        /'
    fail=$((fail + 1))
    return 1
  fi
  echo "smoke: PASS  ${name} body carries exactly one beacon and no injected script tag"
  pass=$((pass + 1))
}

echo "smoke: base=$BASE slug=$VALID_SLUG attempts=$ATTEMPTS"
echo "smoke: canonical=$EXPECTED_ORIGIN forbidden=${FORBIDDEN_ORIGIN:-<none>}"

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

# A malformed token is rejected on shape, before KV is touched. Since #111 the
# session id is not a credential, so there is no session-id branch to probe.
check_body "GET /api/download malformed token" 400 "invalid-token" \
  "$BASE/api/download?token=not-a-token"

# ORDERS bound: a well-formed but unknown token is a 404, so a 503 here means
# the KV binding is missing from the preview env.
check_any "GET /api/download unknown token" "404 503" \
  "$BASE/api/download?token=$(printf 'a%.0s' {1..32})"

# HMAC guard: a 400 (not 503) means PRINT_ASSET_HMAC_SECRET is present in the
# preview env. Malformed exp fails the shape check before the expiry check.
check_body "GET /api/print-asset unsigned" 400 "invalid-exp" \
  "$BASE/api/print-asset?slug=$VALID_SLUG&exp=abc&sig=$(printf 'a%.0s' {1..64})"

# The SEO surface, and only that: these are the five markers whose absence cost
# #437 fourteen hours. The old smoke fetched seven pages and four API paths, all
# of which rendered on a build with no /llms.txt, no sitemap and no beacon, and
# `assert-artifact-origin.sh` reads artifact bytes without ever requesting a
# route — so a build that had silently lost the entire SEO surface passed both
# gates and deployed. Asserting that the routes are *served* is the gap; what
# they contain is asserted here too, because a route that answers 200 with the
# wrong origin is the same defect the artifact assertion exists to catch, seen
# from the outside where the artifact cannot reach.
check_body "GET /llms.txt names this origin" 200 "$EXPECTED_ORIGIN" "$BASE/llms.txt"
check_header "GET /llms.txt content type" 200 "content-type: text/plain" "$BASE/llms.txt"
if [[ -n "$FORBIDDEN_ORIGIN" ]]; then
  # The direction that fails: an artifact built for the other environment serves
  # that environment's canonicals, and #436/#437 shipped exactly that.
  check_body_forbids_host "GET /llms.txt omits the other origin" 200 "$FORBIDDEN_ORIGIN" \
    "$BASE/llms.txt"
else
  echo "smoke: SKIP  /llms.txt cross-origin check (no other origin for $EXPECTED_ORIGIN)"
fi
check_body "GET /sitemap.xml names this origin" 200 "<loc>$EXPECTED_ORIGIN/" "$BASE/sitemap.xml"
check_header "GET /sitemap.xml content type" 200 "content-type: application/xml" "$BASE/sitemap.xml"
check_body "GET /robots.txt points at the sitemap" 200 "Sitemap:" "$BASE/robots.txt"

# This site's Web Analytics is the manual beacon in AnalyticsBeacon.tsx, and the
# reason it is the *only* one is configuration, not the Worker: Cloudflare's
# automatic injection does reach an OpenNext Worker's HTML. It fires only for
# browser-like user agents, so curl never saw it — which is how a second beacon
# served every visitor for a day while this script reported a clean HTML.
#
# When both are present the first one to run seeds `window.__cfBeacon` and ours
# merges into it, dropping `send.to`: the endpoint resolves to null, zero
# pageviews are sent, and every status code in this file is still 200. So the
# checks below run on a browser-like request and assert the count, not the
# presence, and they fail the release if injection is ever re-enabled. A config
# assertion would only prove intent, would need account WA credentials in CI,
# and would miss an injector nobody has heard of.
#
# A build whose NEXT_PUBLIC_SITE_URL is local renders no beacon on purpose, so
# dev and test traffic never reaches production Web Analytics (#443): this is
# the CI battery's Worker run and a local preview. Asserting the beacon there
# would demand the flood back, so the checks report themselves skipped instead of
# pretending either way.
case "$EXPECTED_ORIGIN" in
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*)
    echo "smoke: SKIP  beacon checks (local origin $EXPECTED_ORIGIN renders none)"
    ;;
  *)
    check_one_beacon "GET / serves exactly one Web Analytics beacon" 200 \
      "${BROWSER_HEADERS[@]}" "$BASE/"
    # The endpoint the snippet pins, not just the script: the beacon posts to
    # /cdn-cgi/rum by default, this Worker 404s that path, and the beacon
    # swallows the error — the pageview is lost with every other check green.
    check_body "GET / beacon reports to the apex RUM endpoint" 200 \
      "cloudflareinsights.com/cdn-cgi/rum" "${BROWSER_HEADERS[@]}" "$BASE/"
    # The beacon is loaded from one host and reports to another. A CSP that named
    # only the script origin blocks every pageview at runtime, which no status
    # code in this script would ever show.
    check_csp_directive "GET / CSP allows the beacon to report" 200 "connect-src" \
      "https://cloudflareinsights.com" "${BROWSER_HEADERS[@]}" "$BASE/"
    ;;
esac

echo "smoke: ${pass} passed, ${fail} failed"
((fail == 0))
