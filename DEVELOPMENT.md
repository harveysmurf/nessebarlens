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

```bash
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

`npm test` runs `node --test` against `tests/fulfillment.test.mts` with a TS loader
(`tests/register.mjs` → `tests/ts-loader.mjs`). Tests are **Node-native, no test
runner framework**.

- Always run `npm test` before opening a PR and again before a deploy.
- CI (see §6) blocks deploy on a failing test run.
- Add a test whenever you change `src/lib/fulfillment.ts`, `pricing.ts`, or any
  quote/order logic.

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

GitHub Actions on `harveysmurf/nessebarlens` (Node 22):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `.github/workflows/ci.yml` | PR + push to `main` | `npm ci` → lint → test |
| `.github/workflows/preview.yml` | PR open/sync | staging Environment → build → Pages preview → PR comment; cleanup on close |
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
- **Stripe webhooks** are verified with Web Crypto (`src/lib/stripe-event.ts`), and
  master keys are read from `photos.ts` (commit `cdac0eb`).
- **Fulfillment is recorded, not executed.** `src/lib/fulfillment.ts` writes
  `paid-unfulfilled` orders to KV `ORDERS` and returns HTTP 200 so Stripe does not
  redeliver. `SKU_MAP_READY` is `false` — keep it false until a SKU map and a
  rotated Prodigi key exist.
- **Shipping constant coupling.** `EU_FLAT_SHIPPING_CENTS` in `fulfillment.ts` must
  stay equal to the checkout route's constant and to `EU_SHIPPING_EUR`.

---

## 8. Code conventions

- **No comments in code** unless the repo already documents a hard invariant — the
  existing `fulfillment.ts` / `wrangler.toml` comments are deliberate and stay.
- Follow existing module boundaries: `src/lib/*` for logic, `src/app/api/*` for
  routes, `src/components/*` for UI, `src/app/*/page.tsx` for pages.
- TypeScript strict; run `npm run lint` before committing.
- Fonts are vendored; never pull them from a CDN at build time.

---

## 9. Release checklist

1. Branch off `main`.
2. Make the change; add/adjust tests in `tests/`.
3. `npm run lint` and `npm test` green locally.
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
- Prodigi fulfillment is scaffolding only — no SKU map, no production call yet.
- Real photographs still need to land in the R2 `MASTERS`/`WEB` buckets to replace
  the 20 placeholders.
