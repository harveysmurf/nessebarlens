#!/usr/bin/env bash
# Put Stripe/Prodigi runtime secrets onto the Cloudflare Worker.
# Usage: sync-worker-secrets.sh
# Requires env: CLOUDFLARE_API_TOKEN (or CF_API_TOKEN), CLOUDFLARE_ACCOUNT_ID
#   (or CF_ACCOUNT_ID), STRIPE_*, PRODIGI_*
set -euo pipefail

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
: "${CLOUDFLARE_API_TOKEN:?}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
: "${STRIPE_SECRET_KEY:?}"
: "${STRIPE_WEBHOOK_SECRET:?}"
: "${PRODIGI_API_KEY:?}"
: "${PRODIGI_SANDBOX_API_KEY:?}"

NAME="${WORKER_NAME:-nessebar-lens}"

put() {
  local key="$1"
  local val="$2"
  printf '%s' "$val" | npx wrangler secret put "$key" --name "$NAME"
}

put STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"
put STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK_SECRET"
put PRODIGI_API_KEY "$PRODIGI_API_KEY"
put PRODIGI_SANDBOX_API_KEY "$PRODIGI_SANDBOX_API_KEY"

echo "synced Worker secrets → $NAME (STRIPE_*, PRODIGI_*)"
