# Stripe webhook fixtures (#225)

Full Stripe event envelopes used by `tests/stripe-contract.test.mts`. They let a
Dependabot bump of the `stripe` package (group `payments`) be checked with no
Stripe secrets: signature verification and event typing run against these.

## Provenance

These files are currently **hand-built from the Stripe API reference**, not
captured from a real sandbox. They are a stand-in until a sandbox key is
available. Replace them with real captures:

    STRIPE_SECRET_KEY=sk_test_... node scripts/capture-stripe-fixtures.mjs

The script lists recent test-mode events, scrubs PII (names, email, phone,
address, receipt URLs, card fingerprints, idempotency keys) and rewrites the
three files. Review the diff before committing.

The three fixtures describe one purchase: a physical giclee order for "dawn"
(30x40, shipped to BG), then its full refund and a dispute on the same charge.

## Rules

- The body is exactly what Stripe sends. Do not add keys for notes.
- `api_version` must equal `STRIPE_API_VERSION` in `src/lib/stripe.ts`. Moving
  that pin means re-capturing the fixtures.
