# e2e/fixtures/orders-seed.json

Three ORDERS KV values, one per success-page state #143 requires: digital paid,
digital processing, physical.

**Why seeded rather than produced by the webhook.** Architect's call on #143:
`next dev` has no ORDERS binding, and the record the webhook writes is the only
other source for one. Standing up a receiver (Stripe CLI, or a local endpoint)
means secrets, signature timing and a second moving part in CI — all to prove
something the browser smoke is not responsible for. So the browser smoke seeds
records, and the webhook loop stays a separate handler-level concern.

**Why hand-written.** Each value is a *stored* order, and the storage format is
part of what is under test. Generating them through `decideFulfillment()` would
only prove the writer agrees with itself. `tests/e2e-seed-fixture.test.mts` runs
every record through the real `parseOrderRecord`, so a fixture that drifts from
the stored shape fails the normal test suite rather than silently rendering the
wrong page state.

**Why the values are JSON strings.** A KV value is the exact bytes
`fulfillment.ts` writes under the session id, and `src/infrastructure/cloudflare/orders-dev-seed.ts`
rejects a nested object rather than re-serialising it — so a fixture cannot
quietly differ from what would really be stored.

**The session ids are fake and safe.** They are `cs_test_…` and shaped like real
Checkout Sessions because `isCheckoutSessionId` rejects anything else before the
page reaches ORDERS. They are never sent to Stripe and cannot be redeemed.