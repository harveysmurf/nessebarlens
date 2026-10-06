# Stripe webhook fixtures (#225)

Full Stripe event envelopes used by `tests/stripe-contract.test.mts`. They let a
Dependabot bump of the `stripe` package (group `payments`) be checked with no
Stripe secrets: signature verification and event typing run against these.

## Provenance

These files are **real sandbox captures**, scrubbed of personal data. Refresh:

    STRIPE_SECRET_KEY=sk_test_... node scripts/capture-stripe-fixtures.mjs

The script lists recent test-mode events, scrubs PII (names, email, phone,
address, receipt URLs, card fingerprints, idempotency keys) and rewrites the
three files. Review the diff before committing.

The checkout event is a physical purchase. The refund and dispute events come
from `verify-stripe.yml`'s own PaymentIntents, so the three do not share a
payment intent or charge; tests must not assume they do.

## Rules

- The body is exactly what Stripe sends. Do not add keys for notes.
- `api_version` is the webhook endpoint's (or account default) version, not
  `STRIPE_API_VERSION` (that pin only governs API requests). When the endpoint
  or account version changes, re-capture and update `WEBHOOK_API_VERSION` in
  the contract test.
