# Nessebar Lens — Development Practices

How we build, test, deploy, and collaborate on this site. Read this before opening a
branch or a pull request. It is the operating manual, not a wish list.

---

## 1. What this is

A minimalist photography storefront for the Old Town of Nessebar. Three galleries
(Fine Art, Archive, Film). Visitors configure a photo — size, frame, paper — see a
live price, and buy: payment is a Stripe Checkout Session, and a print is
fulfilled by Prodigi with a digitally-delivered file as the alternative. Fulfillment
is driven by the Stripe webhook, which records the order in KV.

Stack:

- **Next.js 15** App Router (React 19), built with `@opennextjs/cloudflare` and
  deployed to **Cloudflare Pages** (see §5 — not Workers).
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
  worktrees beside the main checkout (`REPOS/nessebarlens-wt-<branch>/`) and
  separate branches.
- **Never** discard, reset, clean, force-push, or delete another agent's branch or
  worktree without Simo's explicit say-so.
- Work on a branch, run tests, open a **GitHub** PR into `main` (§9), and announce
  it in the `nessebar-lens-website` channel. Merges happen after approval — see §9
  for who approves and what "approved" means.
- Secrets live at `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`, symlinked
  into the checkout as `.env.local`. `.env*` is git-ignored. Never commit a token.

---

## 3. Local development

The project pins its node version in `.nvmrc` (`24.21.0`, the current LTS
line). Node 20 cannot run the suite at all — it fails on `.mts` with
`ERR_UNKNOWN_FILE_EXTENSION`, because type stripping is the loader's job here.
Not every 24.x works either: **24.10 fails `tests/routes.test.mts`** on a
loader change, so `engines.node` is `>=24.21.0 <25` and every workflow pins
`node-version` to the exact `.nvmrc` value. Bump all three together
(`.nvmrc`, `engines.node`, each workflow) — `tests/node-version-pin.test.mts`
fails if they drift.

```bash
nvm use              # honours .nvmrc — do this FIRST, see below
npm install          # land under /mnt/storage, never the root fs
npm run dev          # next dev (OpenNext dev bindings auto-init)
npm run lint         # eslint
npm test             # node --test (see §4)
npm run cf-typegen   # regenerate cloudflare-env.d.ts from wrangler.toml
```

**Always `nvm use` before anything else — it is not optional and it is not
automatic.** A shell whose `node` predates the pin will run the wrong runtime and
report failures that are not the code's fault: on Node 20 the suite fails every
test file with `ERR_UNKNOWN_FILE_EXTENSION` on `.mts`, which reads exactly like
a broken rebase or a bad merge but is neither. Check with `node -v` (expect
`v24.21.0`) before trusting a red run. If the shell is non-interactive (an agent
harness, a CI step, a cron job) `nvm` may not be on the path at all — source it
first, and verify the version actually changed rather than assuming:

```bash
export NVM_DIR=/mnt/storage/apps/nvm   # not the default ~/.nvm, this is the 2TB drive
. "$NVM_DIR/nvm.sh"
cd /path/to/nessebarlens && nvm use   # reads .nvmrc; no-op + warning outside the repo
node -v                                # must print v24.21.0
```

`nvm use` prints `No .nvmrc file found` and changes nothing when run outside the
repo root — that is the other way to end up on the wrong runtime.

If `nvm` is not installed at all (some agent containers ship bare Node 20), skip
it rather than debugging the red run. Unpack the exact pin from nodejs.org into
a scratch dir on the 2TB drive and put it first on `PATH`:

```bash
PIN=$(cat .nvmrc)
cd /mnt/storage/.../scratch
curl -fsSLO "https://nodejs.org/dist/v${PIN}/node-v${PIN}-linux-x64.tar.xz"
tar -xJf "node-v${PIN}-linux-x64.tar.xz"          # extracts node-v…-linux-x64/bin/node
export PATH="$PWD/node-v${PIN}-linux-x64/bin:$PATH"
node -v                                             # must print v24.21.0
```

`linux-x64` is this box's arch; on arm64 use `linux-arm64` in all three lines.

Do not write the tarball to the repo or to `/` — `/` is nearly full on this box.

A **fresh worktree has no `node_modules`** (it is git-ignored), so run `npm ci`
once per worktree before `npm test`, `npm run lint`, or `npx tsc --noEmit`.
Without it, `npx` silently downloads a different `tsc`/`eslint` from the
registry, which fails on missing packages and looks like a config error.

Environment variables (names only — values live in the `.env.local` symlink):

| Var | Purpose |
|-----|---------|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Wrangler / OpenNext deploy auth |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `PRODIGI_API_BASE` | Explicit Prodigi host: `https://api.sandbox.prodigi.com` or `https://api.prodigi.com` (never inferred from key presence) |
| `PRODIGI_SANDBOX_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is sandbox |
| `PRODIGI_API_KEY` | Prodigi key used when `PRODIGI_API_BASE` is live |
| `PRINT_ASSET_HMAC_SECRET` | ≥32-char HMAC secret for `/api/print-asset` (Prodigi). **Required for physical checkout, not optional** — `/api/checkout` calls `canSignMasterAsset()` and answers **503** rather than take the money for a print it cannot fulfill, and `/api/print-asset` answers 503 `print-asset-unavailable` when unset. A short or whitespace-only value is treated as unset. |
| `NEXT_PUBLIC_SITE_URL` | Canonical public origin (used by `src/lib/stripe.ts`). **Required for any production build** — `next.config.ts` fails the build without it, because `NEXT_PUBLIC_*` is inlined at build time and a silent `http://localhost:3000` fallback would ship a checkout that redirects to localhost. `next dev` and `npm test` do not need it. |
| `NEXT_PUBLIC_WEB_IMAGES_BASE` | Base URL for gallery `<img>` srcset |
| `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` | Opt-in gate for the R2 derivative ladder. Unset = placeholders. Only `true`/`1` enable it — a configured base alone does **not**. |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 creds (unused by Workers — they use bucket bindings) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Needed only by `npm run ingest` from a laptop (see §6a) |
| `EU_SHIPPING_EUR` | Flat EU shipping (must match `EU_FLAT_SHIPPING_CENTS`) |

---

## 4. Testing

`npm test` runs `node --test tests/*.test.mts` — the **whole suite** — on
**node 24**, with types stripped by node itself and one resolve hook
(`tests/register.mjs` → `tests/resolve-hooks.mjs`) for extensionless relative
imports. Tests are **Node-native, no test runner framework**.

`npm run coverage` enforces the floors in `scripts/coverage.mjs` (lines 99.95%,
branches 99.9%, functions 100%) and is a **separate CI step** — a green
`npm test` says nothing about coverage, and CI runs both.

Because stripping happens in place, `src/` must stay erasable-syntax only — no
`enum`, `namespace`, or `declare module`. `tests/resolve-hooks.test.mts` fails
the build if that ever changes, because tsc does not cover the files no test
imports.

- Always run `npm test` before opening a PR and again before a deploy.
- CI (see §6) blocks deploy on a failing test run.
- Add a test whenever you change `src/lib/order-decision.ts`,
  `src/lib/fulfillment.ts`, `pricing.ts`, or any quote/order logic.

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

GitHub Actions on `harveysmurf/nessebarlens` (Node 24.21.0, see §3):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `.github/workflows/ci.yml` | PR + push to `main` | `npm ci` → lint → typecheck → test → **coverage floors** |
| `.github/workflows/preview.yml` | PR open/sync | staging Environment → build → Pages preview → **smoke test** (`scripts/smoke.sh`) → PR comment; cleanup on close |
| `.github/workflows/prod.yml` | push to `main` + `workflow_dispatch` | production Environment → build → Pages `main` → `sync-pages-secrets.sh production` |

### Rotating a credential

Update the GitHub Environment secret, then **Run workflow** on `prod.yml`
(`workflow_dispatch`). That one build is what applies it — no code commit, no
Cloudflare dashboard, no PR.

A deploy is unavoidable and this is not a design gap: Pages `env_vars` are
frozen into a deployment when it is created, so a synced value does not reach
traffic until the next deploy. `wrangler pages secret put` does not help — it
PATCHes the same `deployment_configs[env].env_vars` map with
`type: secret_text` (it does support `--env production|preview`). There is no
deploy-free rotation path on Pages. A standalone sync-without-deploy workflow
existed briefly and was deleted: it changed config that nothing served, which
is a silent-failure trap.

Expect a few minutes between merge and the deploy starting — that is GitHub
Actions queue latency, not a dropped run. Check the Actions tab before
re-dispatching.

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

## 6a. Ingesting photos (masters → R2 ladder)

Simo runs this from his own box, not CI. Three prerequisites, in order:

1. **Node 24.21** — `nvm use` in the repo root. `npm run ingest` checks the
   pin in `.nvmrc` and stops with `ingest needs Node 24.21.0` otherwise,
   because `sharp` is a native binding and a mismatch otherwise surfaces as an
   opaque `ERR_UNKNOWN_FILE_EXTENSION`.
2. **`npm install`** — `sharp` and `@aws-sdk/client-s3` are devDependencies
   only the ingest uses; the site itself never imports them.
3. **R2 credentials in `.env.local`** (gitignored) or exported:

   ```
   R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   ```

   From Cloudflare → R2 → Manage R2 API Tokens → *Object Read & Write* scoped
   to `nessebar-lens-masters` and `nessebar-lens-web`. The workspace copy of
   these lives in `/mnt/storage/services/buzz/secrets/nessebar-lens/.env`.
   Missing keys fail as `missing env: R2_ACCESS_KEY_ID ...`, never as a 403.

Then, per photo:

1. Drop the master JPEG in `ingest/` (repo root, gitignored), **named for its
   slug** — `alley-cat.jpg` is the catalog slug `alley-cat`. Files not matching
   `{slug}.jpg` are reported and skipped, so a `.DS_Store` or `IMG_4021.jpg`
   cannot become an unlinkable photo.
2. `npm run ingest` — **dry run by default.** It prints every object it would
   write, in both buckets, and uploads nothing. Read that list.
3. `npm run ingest -- --apply` — writes the original to
   `nessebar-lens-masters/prints/{slug}.jpg` and each rung to
   `nessebar-lens-web/{slug}/{750,1500,2500}.jpg`. Width-driven resize, aspect
   ratio preserved, no crop: the list page's uniform tiles are a CSS
   `aspect-ratio` with `object-fit: cover`, and the photo page is uncropped.
   `--only alley-cat` narrows a run to one photo.
4. Verify a couple of URLs resolve under `NEXT_PUBLIC_WEB_IMAGES_BASE`, **then**
   set `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED=true`. Only `true` or `1` enable
   the ladder; a configured base alone does not.

Idempotent — re-running overwrites the same keys with the same bytes. The run
**refuses outright** if `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` is set, because at
that point the site is already serving this bucket and a half-written ladder
would 404 the storefront. Turn the flag off, ingest, verify, then turn it on.

The rung list is `WEB_DERIVATIVE_WIDTHS` in `src/lib/derivative-ladder.ts` —
one array, read by both the srcSet the site serves and the plan the script
executes. Changing the rungs is a one-line edit there; do not add widths in the
script.

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
- **The derivative ladder is gated.** `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED`
  (default off) decides between the R2 ladder (`{slug}/{width}.jpg` in
  `nessebar-lens-web`) and the committed placeholders. Set the base without the
  flag and the gallery keeps serving placeholders — that is deliberate, because
  the base is configured in every environment while both buckets are still
  empty. Turn the flag on only after the upload is verified, and expect
  `tests/placeholder-photo.test.mts` to need updating at that moment.
- **Quotes are cached; checkout is not.** `/api/quote` is unauthenticated and
  shares Prodigi's rate limit with `/api/checkout`, so a cached-miss loop could
  otherwise 429 Prodigi and break checkout for real customers. `src/lib/quote-cache.ts`
  caches the two public numbers (`merchandiseEur`, `shippingEur`) per
  `(SKU, attributes, destinationCountry)` for 30 minutes in `caches.default`.
Three invariants: (1) `sku` and `unitCostEur` never enter the cached
   *value* — the wholesale cost and the margin stay server-side. (The `sku`
   necessarily appears in the cache *key*, which is server-side on an `.invalid`
   origin and never returned to a caller); (2) `/api/checkout` keeps
  quoting live, so the price charged is the price Prodigi just returned; (3) any
  cache error degrades to a live quote, never to a 5xx. Covered by
  `tests/quote-cache.test.mts` and `tests/routes.test.mts`.
- **Rate limit on `/api/quote`.** The application-level cache above is the
  defence that needs no dashboard access; the Cloudflare WAF rule is the second
  layer and is **configured in the dashboard, not in this repo** (Wrangler does
  not manage rate-limit rules). Zone `nessebar-lens.com`: Rate Limiting Rules →
  expression `http.request.uri.path eq "/api/quote"`, characteristic `ip.src`,
  30 requests / 1 minute, mitigation `block`, period 60s. If the zone has no
  rate-limit plan, the equivalent is a WAF custom rule with
  `cf.ratelimit.counting_period eq 60`. Nothing in CI verifies this — if you
  change the threshold, update it here too.
- **Stripe Checkout only.** `/api/checkout` creates a Checkout Session
  (`success_url` / `cancel_url`); no code path confirms a PaymentIntent. Stripe
  sandbox emails about a missing `return_url` are expected after manual
  `paymentIntents.confirm` probes — ignore them.
- **Stripe webhooks** are verified with Web Crypto (`src/lib/stripe-event.ts`), and
  master keys are read from `photos.ts` (commit `cdac0eb`).
- **Fulfillment is recorded, not executed.** The rules live in
  `src/lib/order-decision.ts` (pure: what a session means, what a stored record
  says, whether a customer may download) and the effects in
  `src/lib/fulfillment.ts`, which writes the
  order to KV `ORDERS`. A *retryable* failure (Prodigi 401/403/429/5xx, an
  unconfigured key or asset secret) is written `terminal: false` and the webhook
  answers 5xx so Stripe redelivers for ~3 days; a terminal one answers 200. The
  record's `reason` says which, so an operator can tell "rotate the key" from
  "back off" from "fix the deploy". No auto-refund: a stuck paid order is
  alerted for a human.
- **Every unfulfilled order logs.** `fulfillCheckoutSession` writes through
  `storeOrder`, the only ORDERS write in the order path, which emits one
  structured `console.error` whenever the stored record is `paid-unfulfilled`:
  `{"event":"order.unfulfilled","sessionId","reason","terminal","format"}`, plus
  `"detail"` carrying the upstream message on a retryable Prodigi failure. KV has
  no operator view, so that line is the only trace of an order we took money for
  and did not ship. Find them with `wrangler tail` on the production worker, or
  in Cloudflare **Workers Logs** filtered on `order.unfulfilled`; locally, run
  `npm test` and read stderr. `AWAITING_PRODIGI_REASON` is excluded — it is an
  internal marker rewritten by the same call, not an outcome.
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
   **Squash a multi-commit PR into one commit on main.** A refactor branch
   accumulates a commit per idea, and main is the place someone reads to learn
   what a module is *for* — a ten-commit trail of "move this, tighten that"
   turns the history into a changelog of mechanics. The one-line rule of thumb:
   if the individual commit subjects do not each make sense as a description of
   the resulting code, squash.
8. Report the PR link, preview URL, and commit hash in the channel.

---

## 10. Known state / open items

- Brand rename "Stefan Todorov" → "Nessebar Lens" is done (commit `18886c3`); keep
  "Old Town Nessebar" as the place name.
- Prodigi order creation is wired end to end: a pinned 9-SKU map (`src/lib/sku-map.ts`),
  live quote + order calls, and a HMAC-signed master asset URL. Sandbox and live
  are selected by an explicit `PRODIGI_API_BASE`, never inferred from the key.
- Real photographs still need to land in the R2 `MASTERS`/`WEB` buckets to replace
  the 20 placeholders. `npm run ingest` (§6a) does that; the ladder stays off
  until the upload is verified.
- If a 502 shows up from `/api/quote` or `/api/checkout` and it is *not* Prodigi
  being down, look at `prodigiErrorStatus` first. 503 means this deploy is
  misconfigured (unset Prodigi key, or a `PRODIGI_API_BASE` outside the two
  allowed hosts); 502 means Prodigi. The split is exact string equality against
  the messages `src/lib/prodigi-config.ts` throws, so a *new* throw site that
  forgets to be classified reports a deploy problem as a bad gateway.
  `tests/prodigi-config.test.mts` enumerates them; that is the file to extend
  when the module gains one.
- `PRODIGI_SHIPPING_METHOD` ("Budget") is the value we quote and buy with, and
  no unit test can confirm Prodigi still accepts that string for the pinned SKUs.
  It is a sandbox check, not a test.
