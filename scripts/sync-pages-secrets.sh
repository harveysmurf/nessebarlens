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

# Print-asset HMAC (the Worker streams masters to Prodigi). Synced only when the
# value is present and >=32 chars; the same rule print-asset.ts applies, so a
# short or blank value is dropped here and reads as unset at runtime — which now
# means /api/checkout answers 503 for physical formats rather than falling back to
# /placeholders/*.jpg. See #114 for the drop being silent.
PRINT_SECRET="${PRINT_ASSET_HMAC_SECRET:-}"
if [[ -n "$PRINT_SECRET" && ${#PRINT_SECRET} -ge 32 ]]; then
  export PRINT_ASSET_HMAC_SECRET="$PRINT_SECRET"
fi

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
print_secret = os.environ.get("PRINT_ASSET_HMAC_SECRET", "").strip()
if len(print_secret) >= 32:
    env_vars["PRINT_ASSET_HMAC_SECRET"] = {
        "type": "secret_text",
        "value": print_secret,
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
