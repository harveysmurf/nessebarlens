# Research: Stripe-hosted Checkout locale (en / bg)

Buzz issue: `264e1e256d1b515a3079ba3f62c089b1707b76cd1b118045cb3f9e51b03819fa` — "Research epic: Stripe-hosted Checkout localization for English and Bulgarian"

Main localization epic: `buzz://issue?id=785b3661d55cbf4af928dfb3592ec79e04a2d6e9b3c6218a737b1856ff2e7aa8&owner=fbe5c9f71d37efdd02a2b23c455eb4f734b7627ae8b88ffe17e1624fc2a6fec9&d=nessebar-lens`

## Scope and constraints

This is research only. Per the epic:

- No production Stripe dashboard change.
- No unverified `checkout.sessions.create` parameter added to production code.
- No implementation patch mixed into this research.
- No live payment, no payment completion, no repo implementation change.

If Stripe supports an explicit `locale`, the exact adapter change and test cases belong in a **separate** implementation issue linked to this epic and the main localization epic.

## Environment checked

| Item | Value | Source |
|------|-------|--------|
| Stripe SDK | `stripe` 23.0.1 | `package.json:40` (`"stripe": "^23.0.1"`) |
| Pinned API version | `2026-09-30.endive` | `src/infrastructure/stripe/stripe.ts:14` (`STRIPE_API_VERSION`) |
| Docs reference | API `2026-10-28.endive` (repo pins `2026-09-30.endive`); the `locale` param and `bg`/`en` values exist in the pinned SDK types | https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-locale |
| Current `locale` passed to Stripe | none | `src/infrastructure/stripe/stripe-gateway.ts:50-108` (`buildSessionParams` sets no `locale`) |
| Intent locale available | yes | `CheckoutIntent.locale` is already populated and used for `formatLabel`, `physicalDescription`, `digitalDescription`, `shippingDisplayName` |

## Answers to the six questions

### 1. Does hosted Checkout support an explicit UI locale? Exact parameter and fallback?

**Yes — sourced.** `locale` is an optional parameter on `POST /v1/checkout/sessions`.

> "The IETF language tag of the locale Checkout is displayed in. If blank or `auto`, the browser's locale is used." — Stripe API reference, `checkout.sessions.create` `locale` parameter.

Exact parameter: `locale` (enum). Supported values include `auto`, `bg`, `en`, plus many others. When omitted or `auto`, Stripe falls back to the buyer's browser locale rather than a merchant-chosen default.

SDK confirmation (stripe 23.0.1): `SessionCreateParams.locale?: SessionCreateParams.Locale`, where `Locale = 'auto' | 'bg' | 'cs' | ... | 'en' | 'en-GB' | ... | OtherString`. The session object also echoes it back: `Session.locale: Session.Locale | null`.

### 2. Are English and Bulgarian supported? Fallback if Bulgarian unsupported?

**Both supported — sourced.** `bg` and `en` are both in the `Locale` enum.

Bulgarian does **not** need a different provider locale value: `bg` is the exact Stripe value for Bulgarian. So there is no unsupported-Bulgarian fallback case to handle; the fallback path only matters if `locale` is omitted/`auto`, in which case Stripe uses the browser locale.

### 3. Does selecting a locale affect the whole hosted shell or only part?

**Documented: the whole hosted Checkout page.** The `locale` parameter sets "the locale Checkout is displayed in" — i.e. the hosted shell (buttons, headings, form labels, validation copy rendered by Stripe).

**Not fully sourced (needs test-mode observation):** which sub-parts remain dependent on the buyer's browser, Stripe account, or chosen payment method rather than on `locale`. Candidates to verify by observation: payment-method-specific UI (e.g. iDEAL bank list, PayPal shell), address-field placeholders/localization (tied to `shipping_address_collection.allowed_countries` and the buyer's country), and any consent/custom-text that Stripe renders independently. Mark these as observed-not-documented unless a test-mode session confirms otherwise.

### 4. Do `price_data.product_data` name/description and shipping display name remain exactly the strings we send?

**Yes — sourced by boundary, not by a single doc line.** The line-item `product_data.name`, `product_data.description`, and `shipping_rate_data.display_name` are merchant-provided strings that Stripe renders as supplied; they are the integration's own copy (already translated per-locale in `buildSessionParams` via `formatLabel`, `physicalDescription`, `digitalDescription`, `shippingDisplayName`).

The boundary: our localized line-item copy = the strings we send (name, description, shipping display name); Stripe's shell copy = everything around it (Checkout button, "Continue to shipping", address labels, validation messages), controlled by `locale`. Setting `locale` does **not** alter or translate our product_data strings.

### 5. Does the setting interact with `adaptive_pricing: { enabled: false }`, allowed shipping countries, success/cancel URLs, metadata, or webhooks?

**No documented interaction.** `locale` is a display-language hint on the hosted page; it is orthogonal to:

- `adaptive_pricing` (currency conversion, off here) — unrelated to language.
- `shipping_address_collection.allowed_countries` — country restriction, independent of language.
- `success_url` / `cancel_url` — merchant URLs, unchanged.
- `metadata` — opaque key/value, unchanged.
- Webhook events (`checkout.session.completed`, etc.) — payload shape unchanged; `locale` is echoed on the session object but carries no payment invariant.

Setting `locale` preserves all current payment invariants.

### 6. What can be proven without completing a payment?

**Sourced without payment:** all of the above (parameter existence, `bg`/`en` membership, default-fallback behavior, SDK type, independence from `adaptive_pricing`/shipping/URLs/metadata/webhooks) come from the API reference and SDK types.

**Requires test-mode observation (not done here, intentionally):** actually creating a `checkout.session` in test mode with `locale: bg` and `locale: en`, retrieving it to confirm `session.locale` echoes back, and opening the hosted URL to confirm the shell renders in Bulgarian vs English. The epic explicitly defers this: "use a minimal test-mode manual inspection ... Do not bypass Stripe hCaptcha/attestation controls and do not make a live charge." This observation is left to a follow-up if the product owner accepts implementation.

## en / bg support matrix

| Question | `en` | `bg` | Documented | Observed (test-mode) |
|----------|------|------|------------|----------------------|
| Explicit `locale` supported on `checkout.sessions.create` | yes | yes | Stripe API ref, `locale` param enum | not done |
| Fallback when omitted/`auto` | browser locale | browser locale | Stripe API ref ("If blank or auto, the browser's locale is used") | not done |
| Whole hosted shell in that language | yes (documented) | yes (documented) | "the locale Checkout is displayed in" | not done |
| `product_data.name`/`description` unchanged | yes | yes | merchant-provided strings rendered as-is | not done |
| `shipping_rate_data.display_name` unchanged | yes | yes | merchant-provided string rendered as-is | not done |
| Independent of `adaptive_pricing`/`allowed_countries`/URLs/metadata/webhooks | yes | yes | no documented interaction | not done |

"Documented" = stated in the Stripe API reference or confirmed in the installed SDK types. "Observed" = requires a test-mode session, intentionally not performed in this research.

## Recommendation

Stripe **does** support an explicit UI locale for hosted Checkout, and **Bulgarian (`bg`) is supported** with no special fallback needed.

If the product owner wants localized hosted Checkout, the safe implementation is:

- Add `locale: intent.locale` to the `Stripe.Checkout.SessionCreateParams` built in `src/infrastructure/stripe/stripe-gateway.ts` `buildSessionParams`. No guard or mapping is needed: `CheckoutIntent.locale` is already narrowed to `"en" | "bg"` by `src/domain/i18n/locale.ts` (`LOCALES = ["en", "bg"]`), which are exactly Stripe's `bg` and `en` locale values.
- Do **not** change `adaptive_pricing`, `shipping_address_collection`, `success_url`/`cancel_url`, `metadata`, or webhook handling.
- Add tests asserting the created session carries `locale` and that `bg` maps to Stripe's `bg` value; keep the e2e / `verify-stripe-integration.mjs` payment invariants unchanged.

Follow-up implementation should be a separate Buzz issue linked to this epic (`264e1e…`) and the main localization epic (`785b366…`).

## Production dashboard change needed?

**None.** Research makes no production configuration change. If implementation proceeds, no dashboard change is required beyond passing `locale` in the API call; Stripe has no separate per-locale Checkout toggle in the Dashboard for this.

## Confirmation (acceptance criteria)

- [x] All six questions have sourced answers (Q3 partially marked as needing observation).
- [x] en/bg support matrix and document-versus-observation distinction are present (above).
- [x] Recommendation names the exact parameter (`locale`) and mapping (`intent.locale` → Stripe `bg`/`en`, no mapping needed), plus tests; no unsafe implementation claim.
- [x] Follow-up implementation framed as a separate Buzz issue linked to this epic and the main localization epic.
- [x] No production configuration, live payment, payment completion, or repo implementation change was made as part of this research. (The only repo change is this research document itself.)
