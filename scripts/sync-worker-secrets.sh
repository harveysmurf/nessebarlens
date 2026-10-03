#!/usr/bin/env bash
# Push Stripe/Prodigi (+ optional NEXT_PUBLIC_*) into a Cloudflare Worker via
# `wrangler secret bulk`.
#
# Usage: sync-worker-secrets.sh <preview|production>
# Requires env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, STRIPE_*,
# PRODIGI_API_BASE, and the Prodigi key that matches the base (sandbox key for
# sandbox host, live key for live host).
#
# The guards below are the #114 regression surface and are unchanged by the
# move off Pages -- see tests/sync-secrets-print-hmac.test.mts.
set -euo pipefail

TARGET="${1:-}"
if [[ "$TARGET" != "preview" && "$TARGET" != "production" ]]; then
  echo "usage: $0 <preview|production>" >&2
  exit 1
fi

# Wrangler reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID itself; the CF_*
# names existed for the Pages REST call and stay as a fallback so the workflow's
# env block reads the same as before. `:?` and not `:-` -- `:-` defaults to empty,
# so the expansion always succeeds and the "guard" silently guards nothing,
# turning a missing token into wrangler's opaque auth error instead of naming
# the variable. Either name is acceptable, not neither.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -z "${CF_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required" >&2
  exit 1
fi
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" && -z "${CF_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ID) is required" >&2
  exit 1
fi
: "${STRIPE_SECRET_KEY:?}"
: "${STRIPE_WEBHOOK_SECRET:?}"
: "${PRODIGI_API_BASE:?}"

SANDBOX_BASE="https://api.sandbox.prodigi.com"
LIVE_BASE="https://api.prodigi.com"
BASE="${PRODIGI_API_BASE%/}"
if [[ "$BASE" != "$SANDBOX_BASE" && "$BASE" != "$LIVE_BASE" ]]; then
  echo "PRODIGI_API_BASE must be $SANDBOX_BASE or $LIVE_BASE" >&2
  exit 1
fi

if [[ "$BASE" == "$SANDBOX_BASE" ]]; then
  : "${PRODIGI_SANDBOX_API_KEY:?}"
else
  : "${PRODIGI_API_KEY:?}"
fi

# Fail loud on a key whose mode contradicts the target. A test key in
# production is otherwise indistinguishable from a live one at this boundary:
# it syncs cleanly and then silently fails to take money. Set
# ALLOW_STRIPE_MODE_MISMATCH=1 to override deliberately (e.g. a live-mode
# smoke test before activation completes).
if [[ "${ALLOW_STRIPE_MODE_MISMATCH:-0}" != "1" ]]; then
  # Stripe issues both standard (sk_*) and restricted (rk_*) keys; the mode
  # suffix is what matters, not the key class. Accept either so a restricted
  # live key is not mistaken for a test key.
  if [[ "$TARGET" == "production" ]]; then
    want=("sk_live_" "rk_live_")
  else
    want=("sk_test_" "rk_test_")
  fi
  key_ok=0
  for w in "${want[@]}"; do
    if [[ "$STRIPE_SECRET_KEY" == "$w"* ]]; then
      key_ok=1
      break
    fi
  done
  if [[ "$key_ok" -ne 1 ]]; then
    echo "$TARGET requires a ${want[0]}* or ${want[1]}* STRIPE_SECRET_KEY (got ${STRIPE_SECRET_KEY:0:8}...)" >&2
    echo "set ALLOW_STRIPE_MODE_MISMATCH=1 if this mismatch is intentional" >&2
    exit 1
  fi
fi

export TARGET
export PROJECT=nessebar-lens
export PRODIGI_API_BASE="$BASE"

# Print-asset HMAC (the Worker streams masters to Prodigi). Same >=32-char rule
# print-asset.ts applies. Unset there means /api/checkout answers 503 for
# physical formats rather than taking money for a print it cannot fulfil, so in
# production this is a hard error rather than a silently dropped secret that
# leaves the deploy green and the site 503ing. Preview only warns: a preview
# build legitimately runs without physical checkout.
PRINT_SECRET="${PRINT_ASSET_HMAC_SECRET:-}"
# Trim before measuring, so this guard and the Python guard below judge the same
# string. Without it a 31-char secret with a trailing newline passes here (32
# chars) and is stripped to 31 downstream -- silently dropped, deploy green,
# the #114 symptom one character later.
PRINT_SECRET="${PRINT_SECRET#"${PRINT_SECRET%%[![:space:]]*}"}"
PRINT_SECRET="${PRINT_SECRET%"${PRINT_SECRET##*[![:space:]]}"}"
if [[ ${#PRINT_SECRET} -lt 32 ]]; then
  if [[ "$TARGET" == "production" ]]; then
    echo "production requires PRINT_ASSET_HMAC_SECRET with at least 32 characters (got ${#PRINT_SECRET})" >&2
    echo "without it /api/checkout answers 503 for physical formats" >&2
    exit 1
  fi
  echo "warning: PRINT_ASSET_HMAC_SECRET unset or under 32 chars — physical checkout will 503 on this preview" >&2
else
  export PRINT_ASSET_HMAC_SECRET="$PRINT_SECRET"
fi

# Transactional email (#117). RESEND_API_KEY rides on the deploying version, so
# a key missing here is not "email is off": the order flow still succeeds and
# the customer gets no confirmation at all. Same shape as the print HMAC --
# hard error in production, warning in preview, because a preview build
# legitimately runs without sending mail.
RESEND_KEY="${RESEND_API_KEY:-}"
RESEND_KEY="${RESEND_KEY#"${RESEND_KEY%%[![:space:]]*}"}"
RESEND_KEY="${RESEND_KEY%"${RESEND_KEY##*[![:space:]]}"}"
if [[ -z "$RESEND_KEY" ]]; then
  if [[ "$TARGET" == "production" ]]; then
    echo "production requires RESEND_API_KEY" >&2
    echo "without it orders succeed and no confirmation email is sent" >&2
    exit 1
  fi
  echo "warning: RESEND_API_KEY unset — no transactional email on this preview" >&2
else
  export RESEND_API_KEY="$RESEND_KEY"
fi

# Bearer token for the Prodigi CloudEvent callback (#117). Prodigi signs nothing,
# so this is our own secret and Prodigi must be configured to send it. Unset
# means the route answers 503 "prodigi-webhook-unconfigured" rather than
# accepting callbacks nobody authenticated -- a deliberate, visible outage
# rather than an open endpoint. Production-only for the same reason: a preview
# URL is never registered with Prodigi, so there is nothing to authenticate.
WEBHOOK_TOKEN="${PRODIGI_WEBHOOK_TOKEN:-}"
WEBHOOK_TOKEN="${WEBHOOK_TOKEN#"${WEBHOOK_TOKEN%%[![:space:]]*}"}"
WEBHOOK_TOKEN="${WEBHOOK_TOKEN%"${WEBHOOK_TOKEN##*[![:space:]]}"}"
if [[ -z "$WEBHOOK_TOKEN" ]]; then
  if [[ "$TARGET" == "production" ]]; then
    echo "production requires PRODIGI_WEBHOOK_TOKEN" >&2
    echo "without it /api/webhooks/prodigi answers 503 for every callback" >&2
    exit 1
  fi
  echo "warning: PRODIGI_WEBHOOK_TOKEN unset — /api/webhooks/prodigi will 503 on this preview" >&2
else
  # 32 hex chars minimum, same bar as the print HMAC: a token short enough to
  # guess is worse than no token, because it looks configured.
  if [[ ${#WEBHOOK_TOKEN} -lt 32 ]]; then
    if [[ "$TARGET" == "production" ]]; then
      echo "production requires PRODIGI_WEBHOOK_TOKEN with at least 32 characters (got ${#WEBHOOK_TOKEN})" >&2
      exit 1
    fi
    echo "warning: PRODIGI_WEBHOOK_TOKEN under 32 characters — weak bearer token on this preview" >&2
  fi
  export PRODIGI_WEBHOOK_TOKEN="$WEBHOOK_TOKEN"
fi

# Secrets go through a 0600 file rather than stdin so the values never appear in
# the process list, and the file is removed on every exit path. In version-only
# mode the caller needs the file to survive the exit, so it names the path via
# SECRETS_OUT and the trap is disarmed before returning.
if [[ "${SYNC_SCOPE:-version}" == "version-only" ]]; then
  : "${SECRETS_OUT:?version-only mode needs SECRETS_OUT pointing at the file the caller will pass to --secrets-file}"
  SECRETS_FILE="$SECRETS_OUT"
  umask 077
else
  SECRETS_FILE="$(mktemp)"
  chmod 600 "$SECRETS_FILE"
fi
cleanup() { rm -f "$SECRETS_FILE"; }
trap cleanup EXIT

python3 - "$SECRETS_FILE" <<'PY'
import json, os, sys

out_path = sys.argv[1]
base = os.environ["PRODIGI_API_BASE"]
sandbox_base = "https://api.sandbox.prodigi.com"

# `wrangler secret bulk` takes a flat {name: value} map with no type field --
# every entry becomes a secret_text binding. PRODIGI_API_BASE rides along as a
# secret for that reason: it is not one, but the app reads it from the runtime
# environment and the bulk command offers no plain-text channel, so it is the
# only way to keep preview on sandbox and production on live without a rebuild.
# NEXT_PUBLIC_* are deliberately not here: they bake at build from the GitHub
# Environment secrets, and adding them here would be a value that looks live
# and never changes.
secrets = {
    "STRIPE_SECRET_KEY": os.environ["STRIPE_SECRET_KEY"],
    "STRIPE_WEBHOOK_SECRET": os.environ["STRIPE_WEBHOOK_SECRET"],
    "PRODIGI_API_BASE": base,
}
if base == sandbox_base:
    secrets["PRODIGI_SANDBOX_API_KEY"] = os.environ["PRODIGI_SANDBOX_API_KEY"]
else:
    secrets["PRODIGI_API_KEY"] = os.environ["PRODIGI_API_KEY"]
# Re-checked here as well as in bash: this is the guard #114 is about, and the
# two must not be able to disagree about whether a value was long enough.
print_secret = os.environ.get("PRINT_ASSET_HMAC_SECRET", "").strip()
if len(print_secret) >= 32:
    secrets["PRINT_ASSET_HMAC_SECRET"] = print_secret
# Email + Prodigi callback bearer (#117). Re-checked here for the same reason as
# the print HMAC: bash judged the length, Python must not disagree about whether
# a value survived, or the guard is decoration.
resend_key = os.environ.get("RESEND_API_KEY", "").strip()
if resend_key:
    secrets["RESEND_API_KEY"] = resend_key
webhook_token = os.environ.get("PRODIGI_WEBHOOK_TOKEN", "").strip()
if len(webhook_token) >= 32:
    secrets["PRODIGI_WEBHOOK_TOKEN"] = webhook_token

with open(out_path, "w") as fh:
    json.dump(secrets, fh)
print("prepared secrets: " + ", ".join(sorted(secrets)))
PY

# SYNC_SCOPE selects how the prepared secrets reach Cloudflare. The two
# workflows both use version-only, and that is the mode to reach for:
#   version-only  run every guard and write the JSON file, apply nothing. The
#                 caller passes it to `deploy`/`upload --secrets-file`, so the
#                 secrets ride on the version that actually serves. prod.yml
#                 and preview.yml both do this.
#   version       `wrangler versions secret bulk` (default) — MINTS A NEW
#                 version holding the secrets; it neither edits the deployed
#                 version nor deploys what it mints. See the branch below.
#   worker        `wrangler secret bulk` — mutates the deployed Worker in place.
#                 This is the genuine no-rebuild rotation path, but on a worker
#                 that also serves another environment it overwrites live
#                 secrets, so never point it at production from a PR.
if [[ "${SYNC_SCOPE:-version}" == "version-only" ]]; then
  echo "secrets prepared at $SECRETS_FILE (not applied; caller passes it to --secrets-file)"
  trap - EXIT
  exit 0
elif [[ "${SYNC_SCOPE:-version}" == "version" ]]; then
  # NOT what the name suggests, and the reason this default is not what either
  # workflow uses: `versions secret bulk` PATCHes /versions/latest, which MINTS
  # A NEW VERSION carrying the secrets. It does not edit the version already
  # deployed, and it does not deploy what it mints. So a rotated key applied
  # this way sits on a version that never serves -- a green run with the old
  # key still live. Neither prod.yml nor preview.yml uses this scope; both use
  # version-only plus `deploy`/`upload --secrets-file`, which puts the secrets
  # on the version that actually serves. Kept because it is the correct
  # primitive for a standalone secret change with no accompanying build.
  npx wrangler versions secret bulk "$SECRETS_FILE"
elif [[ "${SYNC_SCOPE:-version}" == "worker" ]]; then
  npx wrangler secret bulk "$SECRETS_FILE"
else
  echo "unknown SYNC_SCOPE=$SYNC_SCOPE (want version-only, version or worker)" >&2
  exit 1
fi

echo "synced $TARGET secrets → Worker (scope=${SYNC_SCOPE})"
