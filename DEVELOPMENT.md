# Nessebar Lens — Development Practices

How we build, test, deploy, and collaborate on this site. Read this before opening a
branch or a pull request. It is the operating manual, not a wish list.

---

## 1. What this is

A minimalist photography showcase for the Old Town of Nessebar. Three galleries
(Fine Art, Archive, Film), no cart, no checkout page. Visitors pick a format and
submit an order inquiry; payment is a Stripe Checkout session and fulfillment is
recorded (Prodigi) rather than executed in code.

Stack:

- **Next.js 15** App Router (React 19) on **Cloudflare Workers** via
  `@opennextjs/cloudflare`.
- **Tailwind CSS 4** for styling. **Inter** (sans) + **Cormorant Garamond**
  (serif) are vendored locally in `src/fonts/` — builds are offline.
- **TypeScript 5**, **ESLint 9** (next/core-web-vitals), **node:test** for tests.
- Bindings: KV `ORDERS`, R2 `WEB` (public derivatives), R2 `MASTERS` (private
  masters). Stripe for payments.

---

## 2. Repo & collaboration

- Origin: `git@github.com:harveysmurf/nessebarlens.git`. The Buzz repo card has no
  clone URL; use the git origin above.
- One agent owns a writable checkout at a time. For concurrent work use separate
  worktrees under `PROJECTS/.worktrees/nessebar-lens-*/` and separate branches.
- **Never** discard, reset, clean, force-push, or delete another agent's branch or
  worktree without Simo's explicit say-so.
- Work on a branch, run tests, open a Buzz PR in the `nessebar-lens-website`
  channel. Merges to `main` happen after approval.
- Secrets live at `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`, symlinked
  into the checkout as `.env.local`. `.env*` is git-ignored. Never commit a token.

---

## 3. Local development

The project pins its node version in `.nvmrc` (`24.21.0`, the current LTS
line). Node 20 cannot run the suite at all — it fails on `.mts` with
`ERR_UNKNOWN_FILE_EXTENSION`, because type stripping is the loader's job here.

```bash
nvm use              # honours .nvmrc
npm install          # land under /mnt/storage, never the root fs
npm run dev          # next dev (OpenNext dev bindings auto-init)
npm run lint         # eslint
npm test             # node --test (see §4)
npm run cf-typegen   # regenerate cloudflare-env.d.ts from wrangler.toml
```

Environment variables (names only — values live in the `.env.local` symlink):

| Var | Purpose |
|-----|---------|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Wrangler / OpenNext deploy auth |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `PRODIGI_API_BASE` | Explicit Prodigi host: `https://api.sandbox.prodigi.com` or `https://api.prodigi.com` (never inferred from key presence) |
| `PRODIGI_SANDBOX_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is sandbox |
| `PRODIGI_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is live |
| `PRINT_ASSET_HMAC_SECRET` | ≥32-char HMAC secret for `/api/print-asset` (Prodigi). Optional — when unset, physical orders use `/placeholders/*.jpg` |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin (used by `src/lib/stripe.ts`) |
| `NEXT_PUBLIC_WEB_IMAGES_BASE` | Base URL for gallery `<img>` srcset |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 creds (unused by Workers — they use bucket bindings) |
| `EU_SHIPPING_EUR` | Flat EU shipping (must match `EU_FLAT_SHIPPING_CENTS`) |

---

## 4. Testing

`npm test` runs `node --test` against `tests/fulfillment.test.mts` on **node 24**,
with types stripped by node itself and one resolve hook
(`tests/register.mjs` → `tests/resolve-hooks.mjs`) for extensionless relative
imports. Tests are **Node-native, no test runner framework**.

Because stripping happens in place, `src/` must stay erasable-syntax only — no
`enum`, `namespace`, or `declare module`. `tests/resolve-hooks.test.mts` fails
the build if that ever changes, because tsc does not cover the files no test
imports.

- Always run `npm test` before opening a PR and again before a deploy.
- CI (see §6) blocks deploy on a failing test run.
- Add a test whenever you change `src/lib/fulfillment.ts`, `pricing.ts`, or any
  quote/order logic.

### Preview smoke test

`scripts/smoke.sh <base-url>` is the only test that runs against a **deployed**
build. `preview.yml` runs it after the Pages deploy and secret sync, and a
failure fails the PR check. It asserts the pages render, the print route 404s an
unknown slug, request bodies are validated, and the HMAC/KV guards are live in
the preview env (a 503 from `/api/download` means ORDERS is not bound).

Run it locally against a build:

```bash
npx opennextjs-cloudflare build && bash scripts/assemble-pages-out.sh
bash scripts/smoke.sh http://127.0.0.1:8788
```

It never calls Prodigi — the live quote path is intentionally out of scope
because sandbox latency makes it flaky per-PR.

---

## 5. Build & deploy

Canonical path is **GitHub Actions** (§6). Manual deploys are for break-glass only.

### Preview (PR / feature branch)

```bash
SITE_URL=https://dev.nessebar-lens.pages.dev npx opennextjs-cloudflare build
bash scripts/assemble-pages-out.sh
npx wrangler pages deploy .pages-out --project-name=nessebar-lens --branch=<branch>
```

Preview URL: `https://<branch>.nessebar-lens.pages.dev`.

### Production (main only)

```bash
SITE_URL=https://nessebarlens.com npx opennextjs-cloudflare build
bash scripts/assemble-pages-out.sh
npx wrangler pages deploy .pages-out --project-name=nessebar-lens --branch=main
bash scripts/sync-pages-secrets.sh production
```

Production and preview both deploy to the **Cloudflare Pages** project
`nessebar-lens`. Apex `nessebarlens.com` / `www` CNAME to
`nessebar-lens.pages.dev`. The idle Worker script is out of the deploy path —
do not use `opennextjs-cloudflare deploy` for deploys.

### Wrangler config invariants (`wrangler.toml`)

- `main = ".open-next/worker.js"`.
- `[assets]` `binding = "ASSETS"`, `run_worker_first = true`.
- Do **not** set `pages_build_output_dir` — that makes Wrangler treat the config as
  a Pages config where `ASSETS` is reserved.
- R2 S3 access keys are unused; Workers/Pages use bucket bindings only (`WEB`,
  `MASTERS`). ORDERS KV + WEB/MASTERS R2 are attached on the Pages project
  (preview + production configs).
- Runtime secrets (Stripe/Prodigi) live as **Pages project secrets** (preview +
  production). Sync with `scripts/sync-pages-secrets.sh`. `NEXT_PUBLIC_*` bake at
  build from GitHub Environment secrets.

---

## 6. CI/CD

GitHub Actions on `harveysmurf/nessebarlens` (Node 24):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `.github/workflows/ci.yml` | PR + push to `main` | `npm ci` → lint → test |
| `.github/workflows/preview.yml` | PR open/sync | staging Environment → build → Pages preview → **smoke test** (`scripts/smoke.sh`) → PR comment; cleanup on close |
| `.github/workflows/prod.yml` | push to `main` | production Environment (required reviewer) → build → Pages `main` → `sync-pages-secrets.sh production` |

GitHub Environments:

- **`staging`** — sandbox Stripe + `PRODIGI_API_BASE=https://api.sandbox.prodigi.com` +
  `PRODIGI_SANDBOX_API_KEY` + `SITE_URL=https://dev.nessebar-lens.pages.dev`
- **`production`** — required reviewer `harveysmurf`. Live Stripe
  (`sk_live_*` + live webhook secret) + `PRODIGI_API_BASE=https://api.prodigi.com` +
  `PRODIGI_API_KEY` (live org key). Host is never inferred from which key is set.
  Preview/staging stays sandbox.

Secrets live in those Environments (never in git). Local `.env.local` remains the
Debian-host symlink to `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`.

---

## 7. Data flow & invariants

- **Catalog is the single source.** `src/lib/photos.ts` `PHOTOS` array holds every
  photo (`slug`, `title`, `category`, `imageKey`, `fromPriceEur`, …). The only
  master-key list is `photos.ts` `imageKey`, surfaced via
  `src/lib/master-key.ts` `masterKeyForSlug()`.
- **Placeholders.** `public/placeholders/{slug}.jpg` are 20 local stand-ins
  (7 fine-art, 7 archive, 6 film). Gallery images resolve to
  `/placeholders/{slug}.jpg`; real photographs replace these on R2 later. Keep the
  slug set stable.
- **No remote image hosts.** `next.config.ts` sets `images.remotePatterns: []` —
  do not add `images.unsplash.com` or any third-party host. Gallery uses plain
  `<img>` srcset against `NEXT_PUBLIC_WEB_IMAGES_BASE` only.
- **Stripe Checkout only.** `/api/checkout` creates a Checkout Session
  (`success_url` / `cancel_url`); no code path confirms a PaymentIntent. Stripe
  sandbox emails about a missing `return_url` are expected after manual
  `paymentIntents.confirm` probes — ignore them.
- **Stripe webhooks** are verified with Web Crypto (`src/lib/stripe-event.ts`), and
  master keys are read from `photos.ts` (commit `cdac0eb`).
- **Fulfillment is recorded, not executed.** `src/lib/fulfillment.ts` writes the
  order to KV `ORDERS`. A *retryable* failure (Prodigi 401/403/429/5xx, an
  unconfigured key or asset secret) is written `terminal: false` and the webhook
  answers 5xx so Stripe redelivers for ~3 days; a terminal one answers 200. The
  record's `reason` says which, so an operator can tell "rotate the key" from
  "back off" from "fix the deploy". No auto-refund: a stuck paid order is
  alerted for a human.
- **One payment, one Prodigi order.** `idempotencyKey` is the Stripe session id, so
  a redelivery that re-attempts gets Prodigi's `alreadyExists` with the original
  order rather than a second print.
- **Own your config errors.** A misconfiguration of *our* deploy must never
  surface as an upstream 502/500. Two corollaries:
  1. Read config getters (`prodigiApiKey`, `prodigiOrdersUrl`, `prodigiQuotesUrl`)
     **before** the request — never inside the `fetch()` argument list, where a
     throw skips the try/catch that translates it.
  2. Every "we are not configured" path produces a **distinct, retryable reason**
     and a **503**, so the record and the log say *what* is unset.

  `isProdigiUnconfigured` is the single predicate for "our fault, not Prodigi's";
  a new config error that does not match it silently becomes a 502.

- **Shipping constant coupling.** `eurToCents` in `pricing.ts` is the one EUR→cents
  rounding in the repo — Stripe line items, the webhook's amount check and the
  stored record must not each redefine it.

---

## 8. Code conventions

- **No comments in code** unless the repo already documents a hard invariant — the
  existing `fulfillment.ts` / `wrangler.toml` comments are deliberate and stay.
- Follow existing module boundaries: `src/lib/*` for logic, `src/app/api/*` for
  routes, `src/components/*` for UI, `src/app/*/page.tsx` for pages.
- TypeScript strict; run `npm run lint` before committing.
- Fonts are vendored; never pull them from a CDN at build time.

### One source per grammar and per shape

Any regex or object type that encodes a rule is declared in **one** module and
imported everywhere else. Tests do not catch a divergent copy while the copies
still behave the same, and that is exactly how two bugs got here: the
master-marker regex and the photo-slug grammar each grew a private second copy
that agreed until it did not.

Owners: `master-key.ts` (slug, master key, MASTERS storage shape),
`master-guard.ts` (master marker), `crypto-hex.ts` (hex signature),
`ship-to-countries.ts` (ISO alpha-2), `url-patterns.ts` (absolute https).

`tests/single-source-grammar.test.mts` enforces this by walking the TypeScript
AST — a regex in a string or a comment is not mistaken for a declaration. It
fails on any regex literal or object shape that appears in two modules.

The guard only sees **syntactic** duplicates. It cannot see two grammars that
mean the same thing but are written differently — `/^https:\/\//i` next to
`URL.canParse(x)` is one rule wearing two coats, and the guard stays green. That
is a naming and design problem, not a lint problem: treat "this belongs to an
existing owner module" as intent you have to apply by reading the code, and use
the guard to keep the honest copy honest.

---

## 9. Release checklist

1. Branch off `main`.
2. Make the change; add/adjust tests in `tests/`.
3. `npm run lint` and `npm test` green locally.
   Run `git status --short` before committing: `git commit -a` stages only
   *tracked* files, so a brand-new module can pass locally and fail CI on a
   missing import. This repo has shipped one red build that way.
4. Push the branch and open a **GitHub** PR into `main`.
5. Wait for CI + staging preview (PR comment with `*.nessebar-lens.pages.dev`).
6. Announce the PR + preview URL in `nessebar-lens-website`; get approval.
7. Merge to `main` → production workflow runs (GitHub Environment approval by
   `harveysmurf`) → https://nessebarlens.com.
8. Report the PR link, preview URL, and commit hash in the channel.

---

## 10. Known state / open items

- Brand rename "Stefan Todorov" → "Nessebar Lens" is done (commit `18886c3`); keep
  "Old Town Nessebar" as the place name.
- Prodigi order creation is wired end to end: a pinned 9-SKU map (`src/lib/sku-map.ts`),
  live quote + order calls, and a HMAC-signed master asset URL. Sandbox and live
  are selected by an explicit `PRODIGI_API_BASE`, never inferred from the key.
- Real photographs still need to land in the R2 `MASTERS`/`WEB` buckets to replace
  the 20 placeholders.
