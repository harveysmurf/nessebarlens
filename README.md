# Nessebar Lens

A minimalist photography storefront for the Old Town of Nessebar. Three galleries —
Fine Art, Archive, Film — with a configurator that prices a print in EUR, a Stripe
Checkout flow, and fulfillment through Prodigi for physical orders.

## Stack

- **Next.js 15** App Router (React 19), built with `@opennextjs/cloudflare`
- **Tailwind CSS 4**; Inter + Cormorant Garamond vendored in `src/fonts/` (offline builds)
- **TypeScript 5**, **ESLint 9**, **node:test** — no test runner framework
- Cloudflare Workers (OpenNext), with D1 (`ORDERS_DB`) and R2 (`WEB` derivatives, `MASTERS` masters)
- Stripe for payments, Prodigi for print fulfillment

## Run it locally

Node **24.21.0** exactly — pinned in `.nvmrc`, and not every 24.x works.

```bash
nvm use          # first, always: a wrong runtime fails the suite for unrelated-looking reasons
npm install
npm run dev
```

Checks:

```bash
npm run lint
npm run typecheck
npm test
npm run coverage   # enforced floors: lines 99.95%, branches 99.9%, functions 100%
```

## Deploy model

Canonical path is GitHub Actions. A PR gets a Cloudflare Workers version preview
(addressed by version id, not a branch alias) and a smoke test against it; a merge
to `main` deploys production. Stripe and Prodigi
credentials live in the GitHub `staging` and `production` Environments and are
attached to the deploying Worker Version by `scripts/sync-worker-secrets.sh`
(guards run first; `--secrets-file` carries them on the version that serves).
Preview/staging is always
Stripe sandbox + Prodigi sandbox; the host is selected by an explicit
`PRODIGI_API_BASE`, never inferred from which key is present.

## Where the details live

**[DEVELOPMENT.md](./DEVELOPMENT.md)** is the operating manual: environment
variables, testing, deploy and secret-rotation procedure, photo ingest, the
data-flow invariants, and the release checklist. Read it before opening a branch.

Two things worth knowing before you touch the payment or fulfillment path:

- Prices are per-photo and per-Prodigi-quote with a flat EUR shipping amount, so
  adaptive pricing is explicitly **disabled** on Checkout sessions — a converted
  local amount is one we neither set nor reconcile.
- Fulfillment is driven by the Stripe webhook, which records the order to D1.
  Unconfigured config fails as a retryable 503, never as an upstream 502.
