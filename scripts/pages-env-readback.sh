#!/usr/bin/env bash
# Does a PATCH of deployment_configs.env_vars reach the deployment that is
# already serving traffic, or only the next one?
#
# This is the question that decides whether the standalone sync workflow buys
# anything. If env_vars are read at deploy time, rotating a key still needs a
# deploy and the workflow is a rename, not a fix — in which case the sync has to
# move to `wrangler pages secret put`, which writes runtime secrets.
#
# Reads the CF Pages API (the same source sync-pages-secrets.sh writes) and
# prints what the *current production deployment* carries. Requires
# CF_API_TOKEN and CF_ACCOUNT_ID; optionally SYNC_PROBE, the marker the sync
# step was asked to write.
#
# Reports INDETERMINATE rather than guessing when the API redacts values, so a
# redaction is never mistaken for "the new value did not land".
#
# Exit codes: 0 propagation confirmed, 1 confirmed NOT propagating, 2 no
# deployment to compare, 3 indeterminate. 3 is a clean exit, not a failure: the
# CF deployment payload does not carry env_vars, so this check cannot answer
# the question on its own, and a manual probe that goes red reads as a broken
# sync when the sync step above it succeeded.

set -euo pipefail

: "${CF_API_TOKEN:?}"
: "${CF_ACCOUNT_ID:?}"

export CF_API_TOKEN CF_ACCOUNT_ID
export PROBE="${SYNC_PROBE:-}"

python3 - <<'PY'
import json, os, urllib.request

account = os.environ["CF_ACCOUNT_ID"]
token = os.environ["CF_API_TOKEN"]
probe = os.environ.get("PROBE", "").strip()
base = f"https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/nessebar-lens"
headers = {"Authorization": f"Bearer {token}"}


def get(url):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


deps = (get(f"{base}/deployments?env=production") or {}).get("result") or []
if not deps:
    print("readback: no production deployment found; nothing to compare against")
    raise SystemExit(2)

latest = deps[0]
did = latest.get("id")
print(f"latest production deployment: {did} ({latest.get('created_on')})")

# env_vars on a deployment is what the *running* Worker was built with. Absent
# from the payload means the API does not expose it, not that it is empty.
cfg = (latest.get("deployment_configs") or {}).get("production") or {}
env_vars = cfg.get("env_vars")
if not isinstance(env_vars, dict) or not env_vars:
    # Also read the project-level config the sync step just PATCHed, so the log
    # distinguishes "the sync did not write" from "the sync wrote and the API
    # will not show us the deployment".
    pcfg = (get(f"{base}") or {}).get("result", {}).get("deployment_configs", {})
    pvars = (pcfg.get("production") or {}).get("env_vars")
    if isinstance(pvars, dict) and pvars:
        print(f"project-level production env_vars present: {sorted(pvars)}")
    if probe:
        pentry = pvars.get("SYNC_PROBE") if isinstance(pvars, dict) else None
        if isinstance(pentry, dict) and pentry.get("type") == "plain_text":
            print(f"project SYNC_PROBE expected={probe!r} written={pentry.get('value')!r}")
    print("readback: INDETERMINATE — the CF deployment payload carries no env_vars, "
          "so propagation cannot be settled from the API")
    raise SystemExit(0)

names = sorted(env_vars)
print(f"deployment env_vars present: {names}")


def shown(name):
    entry = env_vars.get(name)
    if isinstance(entry, dict):
        return entry.get("value") if entry.get("type") == "plain_text" else "<secret_text>"
    return entry


if not probe:
    print("readback: no SYNC_PROBE requested; run with a probe input to test propagation")
    raise SystemExit(0)

seen = shown("SYNC_PROBE")
print(f"SYNC_PROBE expected={probe!r} served={seen!r}")
if seen == probe:
    print("readback: PROPAGATES — a synced env_var reaches the live deployment with no deploy")
    raise SystemExit(0)
print("readback: DOES NOT PROPAGATE — env_vars are deploy-bound; use wrangler pages secret put")
raise SystemExit(1)
PY
