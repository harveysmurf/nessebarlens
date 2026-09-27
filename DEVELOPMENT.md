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
| `STRIPE_SECRET_KEY` | Stripe Checkout (sandbox) |
| `PRODIGI_API_KEY` | Prodigi POD (not yet called from code) |
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

Two distinct paths — never mix them.

### Preview (feature branches)

```bash
wrangler pages deploy --branch=dev
```

Preview URL: `https://dev.nessebar-lens.pages.dev` (and per-branch
`https://<branch>.nessebar-lens.pages.dev`).

### Production (main only)

```bash
SITE_URL=https://nessebarlens.com opennextjs-cloudflare build
opennextjs-cloudflare deploy
```

`opennextjs-cloudflare deploy` is **production-only**. `wrangler pages deploy` is
**preview-only**. Production runs with `run_worker_first = true` so OpenNext serves
static files through `env.ASSETS` itself.

Production: https://nessebarlens.com

### Wrangler config invariants (`wrangler.toml`)

- `main = ".open-next/worker.js"`.
- `[assets]` `binding = "ASSETS"`, `run_worker_first = true`.
- Do **not** set `pages_build_output_dir` — that makes Wrangler treat the config as
  a Pages config where `ASSETS` is reserved.
- R2 S3 access keys are unused; Workers use bucket bindings only (`WEB`, `MASTERS`).

---

## 6. CI/CD

There is no GitHub Actions. Buzz workflows cannot run shells, tests, or wrangler and
have no PR trigger. CI is a **systemd timer on this Debian host** (owned by Senior
Dev):

- New PR tip → `npm test` → Pages preview → post preview URL on the PR. Skip deploy
  on test failure.
- New `main` commit → `npm test` → production deploy to https://nessebarlens.com.
  Skip deploy on test failure.
- Failures are posted to the `nessebar-lens-website` channel.

Until the timer lands, deploys are driven by hand (wrangler / opennextjs-cloudflare)
as documented in §5.

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
3. `npm run lint` and `npm test` green.
4. Preview deploy with `wrangler pages deploy --branch=dev`; verify on
   https://dev.nessebar-lens.pages.dev.
5. Open a Buzz PR in `nessebar-lens-website`; paste test output and the preview URL.
6. On approval, merge to `main` and production deploy (§5) with
   `SITE_URL=https://nessebarlens.com`.
7. Report the PR link, both URLs, and the commit hash in the channel.

---

## 10. Known state / open items

- Brand rename "Stefan Todorov" → "Nessebar Lens" is done (commit `18886c3`); keep
  "Old Town Nessebar" as the place name.
- Prodigi fulfillment is scaffolding only — no SKU map, no production call yet.
- Real photographs still need to land in the R2 `MASTERS`/`WEB` buckets to replace
  the 20 placeholders.
