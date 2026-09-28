#!/usr/bin/env bash
# Sync Stripe/Prodigi (+ optional NEXT_PUBLIC_*) into Cloudflare Pages
# deployment_configs for preview or production.
#
# Usage: sync-pages-secrets.sh <preview|production>
# Requires env: CF_API_TOKEN, CF_ACCOUNT_ID, STRIPE_*, PRODIGI_API_BASE,
# and the Prodigi key that matches the base (sandbox key for sandbox host,
# live key for live host).
set -euo pipefail

TARGET="${1:-}"
if [[ "$TARGET" != "preview" && "$TARGET" != "production" ]]; then
  echo "usage: $0 <preview|production>" >&2
  exit 1
fi

: "${CF_API_TOKEN:?}"
: "${CF_ACCOUNT_ID:?}"
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

export TARGET
export PROJECT=nessebar-lens
export PRODIGI_API_BASE="$BASE"

python3 - <<'PY'
import json, os, urllib.request

target = os.environ["TARGET"]
account = os.environ["CF_ACCOUNT_ID"]
token = os.environ["CF_API_TOKEN"]
project = os.environ["PROJECT"]
base = os.environ["PRODIGI_API_BASE"]
sandbox_base = "https://api.sandbox.prodigi.com"

env_vars = {
    "STRIPE_SECRET_KEY": {"type": "secret_text", "value": os.environ["STRIPE_SECRET_KEY"]},
    "STRIPE_WEBHOOK_SECRET": {"type": "secret_text", "value": os.environ["STRIPE_WEBHOOK_SECRET"]},
    "PRODIGI_API_BASE": {"type": "plain_text", "value": base},
}
if base == sandbox_base:
    env_vars["PRODIGI_SANDBOX_API_KEY"] = {
        "type": "secret_text",
        "value": os.environ["PRODIGI_SANDBOX_API_KEY"],
    }
else:
    env_vars["PRODIGI_API_KEY"] = {
        "type": "secret_text",
        "value": os.environ["PRODIGI_API_KEY"],
    }
# Optional public build/runtime hints (plain text)
for name in ("NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_WEB_IMAGES_BASE"):
    val = os.environ.get(name, "").strip()
    if val:
        env_vars[name] = {"type": "plain_text", "value": val}

body = {"deployment_configs": {target: {"env_vars": env_vars}}}
url = f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{project}"
req = urllib.request.Request(
    url,
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    method="PATCH",
)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)
if not data.get("success"):
    raise SystemExit(f"CF Pages secret sync failed: {data}")
keys = list((data.get("result") or {}).get("deployment_configs", {}).get(target, {}).get("env_vars", {}).keys())
print(f"synced {target} env_vars → {sorted(keys)}")
PY
