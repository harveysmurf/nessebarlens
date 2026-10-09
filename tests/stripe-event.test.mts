import Stripe from "stripe";
import assert from "node:assert/strict";
import test from "node:test";
import {
  readStripeEvent,
  verifyStripeSignatureWebCrypto,
} from "../src/infrastructure/stripe/stripe-event.ts";
import { hmacSha256Hex } from "../src/domain/pricing/crypto-hex.ts";

const SECRET = "whsec_test_secret_for_signature_checks";
const PAYLOAD = JSON.stringify({ id: "evt_1", object: "event", type: "payment_intent.succeeded" });

function header(timestamp: number, sig: string, scheme = "v1"): string {
  return `t=${timestamp},${scheme}=${sig}`;
}

async function sign(timestamp: number, secret = SECRET): Promise<string> {
  return hmacSha256Hex(`${timestamp}.${PAYLOAD}`, secret);
}

test("a correctly signed fresh webhook verifies", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    true,
  );
});

test("a wrong secret never verifies", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp, "whsec_other");
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    false,
  );
});

test("a signature from a different payload never verifies", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await hmacSha256Hex(`${timestamp}.{"id":"evt_other"}`, SECRET);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    false,
  );
});

test("stale signatures past the 300s tolerance are rejected", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000) - 301;
  const sig = await sign(timestamp);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    false,
  );
  // 299s old is still inside the window.
  const fresh = Math.floor(nowMs / 1000) - 299;
  const freshSig = await sign(fresh);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(fresh, freshSig), SECRET, nowMs),
    true,
  );
});

test("future-dated timestamps are rejected, not just old ones", async () => {
  // Without a lower bound, a far-future t= is accepted: age is negative, so
  // the "too old" check never trips and the signature replays for an
  // unbounded amount of time as the clock catches up.
  const nowMs = 1_700_000_000_000;
  const future = Math.floor(nowMs / 1000) + 3_600;
  const sig = await sign(future);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(future, sig), SECRET, nowMs),
    false,
  );
  // Small clock skew is tolerated, as Stripe does.
  const skewed = Math.floor(nowMs / 1000) + 5;
  const skewSig = await sign(skewed);
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(skewed, skewSig), SECRET, nowMs),
    true,
  );
});

test("malformed headers are rejected without throwing", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  const bad = [
    "",
    "t=notanumber,v1=" + sig,
    "t=0,v1=" + sig,
    "t=" + timestamp,
    header(timestamp, "zz".repeat(32)),
    header(timestamp, sig, "v0"),
    "t=" + timestamp + ",v1=",
  ];
  for (const h of bad) {
    assert.equal(
      await verifyStripeSignatureWebCrypto(PAYLOAD, h, SECRET, nowMs),
      false,
      h,
    );
  }
  // Missing inputs are false, not exceptions.
  assert.equal(await verifyStripeSignatureWebCrypto("", header(timestamp, sig), SECRET, nowMs), false);
  assert.equal(await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), "", nowMs), false);
});

test("any matching v1 signature in a multi-signature header wins", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  const multi = `v0=${"00".repeat(32)},v1=${"11".repeat(32)},t=${timestamp},v1=${sig}`;
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, multi, SECRET, nowMs),
    true,
  );
});

test("uppercase hex signatures verify (hex is not case-sensitive)", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = (await sign(timestamp)).toUpperCase();
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    true,
  );
});

test("readStripeEvent returns the parsed event when the signature is good", async () => {
  // No nowMs: the Node constructEvent path checks the real clock, so the
  // signature must be built against it.
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = await sign(timestamp);
  const event = await readStripeEvent(PAYLOAD, header(timestamp, sig), SECRET);
  assert.equal(event.type, "payment_intent.succeeded");
});

test("readStripeEvent rethrows a signature failure instead of falling back", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const badSig = "ab".repeat(32);
  await assert.rejects(
    readStripeEvent(PAYLOAD, header(timestamp, badSig), SECRET, {
      construct: () => {
        throw new Stripe.errors.StripeSignatureVerificationError(
          badSig,
          "whsec_test",
        );
      },
    }),
    (error: unknown) => error instanceof Stripe.errors.StripeSignatureVerificationError,
  );
});

test("readStripeEvent falls back to Web Crypto when construct throws for another reason", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  const event = await readStripeEvent(PAYLOAD, header(timestamp, sig), SECRET, {
    nowMs,
    construct: () => {
      throw new Error("no node crypto in this runtime");
    },
  });
  assert.equal(event.id, "evt_1");
});

test("readStripeEvent rejects a non-event payload that passes the signature", async () => {
  const nowMs = 1_700_000_000_000;
  const payload = JSON.stringify({ id: "evt_2", object: "charge" });
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await hmacSha256Hex(`${timestamp}.${payload}`, SECRET);
  await assert.rejects(
    readStripeEvent(payload, header(timestamp, sig), SECRET, {
      nowMs,
      construct: () => {
        throw new Error("runtime cannot construct");
      },
    }),
    /invalid-event/,
  );
});

test("a signature with no timestamp in the header is rejected", async () => {
  // Stripe always sends t=, so a v1-only header is not something we expect to
  // see. What matters is that the age check cannot be skipped by omitting it:
  // without a timestamp the header must not verify at all.
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  for (const h of [`v1=${sig}`, `v0=${sig},v1=${sig}`, `v1=${sig},`, `,v1=${sig}`]) {
    assert.equal(
      await verifyStripeSignatureWebCrypto(PAYLOAD, h, SECRET, nowMs),
      false,
      h,
    );
  }
  // The same header signed with a fresh t= does verify, so the rejection above
  // is the missing timestamp and not the signature.
  assert.equal(
    await verifyStripeSignatureWebCrypto(PAYLOAD, header(timestamp, sig), SECRET, nowMs),
    true,
  );
});

test("a non-positive or fractional t= is not a usable timestamp", async () => {
  // Number() happily produces these from the header text; the age check is
  // meaningless against them, so they are rejected before the signature is
  // compared.
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  for (const t of ["-1", "0", "1.5", "NaN", "Infinity"]) {
    assert.equal(
      await verifyStripeSignatureWebCrypto(PAYLOAD, `t=${t},v1=${sig}`, SECRET, nowMs),
      false,
      t,
    );
  }
});

test("a duplicate t= is decided by the first one, not the first usable one", async () => {
  // The timestamp reader returns on the first `t=` it finds, so an unusable
  // first value poisons the header rather than being skipped. Pinned because
  // the header is now parsed by one shared reader, and it would be easy to
  // "fix" this into first-usable-wins while deduplicating.
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.equal(
      await verifyStripeSignatureWebCrypto(
        PAYLOAD,
        `t=${bad},t=${timestamp},v1=${sig}`,
        SECRET,
        nowMs,
      ),
      false,
      bad,
    );
  }
  // Control: the good one first, the bad one after, still verifies. Without
  // this the test above would pass even if every t= were rejected.
  assert.equal(
    await verifyStripeSignatureWebCrypto(
      PAYLOAD,
      `t=${timestamp},t=0,v1=${sig}`,
      SECRET,
      nowMs,
    ),
    true,
  );
});

test("every well-formed v1= is collected, not just the first", async () => {
  // The mirror image of the timestamp rule: the signature reader accumulates.
  // Stripe sends a second v1= during secret rotation, so dropping later ones
  // would break every rotation window.
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  const rotated = await sign(timestamp, "whsec_rotated");
  const malformed = "nothex";
  assert.equal(
    await verifyStripeSignatureWebCrypto(
      PAYLOAD,
      `t=${timestamp},v1=${malformed},v1=${sig}`,
      SECRET,
      nowMs,
    ),
    true,
    "a usable signature after a malformed one",
  );
  assert.equal(
    await verifyStripeSignatureWebCrypto(
      PAYLOAD,
      `t=${timestamp},v1=${sig},v1=${malformed}`,
      SECRET,
      nowMs,
    ),
    true,
    "a usable signature before a malformed one",
  );
  assert.equal(
    await verifyStripeSignatureWebCrypto(
      PAYLOAD,
      `t=${timestamp},v1=${sig},v1=${rotated}`,
      SECRET,
      nowMs,
    ),
    true,
    "the earlier of two good signatures is the one that matches",
  );
  assert.equal(
    await verifyStripeSignatureWebCrypto(
      PAYLOAD,
      `t=${timestamp},v1=${malformed},v1=${rotated}`,
      SECRET,
      nowMs,
    ),
    false,
    "two malformed/foreign signatures verify nothing",
  );
});

test("a part with no = is skipped, never fatal", async () => {
  const nowMs = 1_700_000_000_000;
  const timestamp = Math.floor(nowMs / 1000);
  const sig = await sign(timestamp);
  for (const h of [
    `t=${timestamp},barepart,v1=${sig}`,
    `barepart,t=${timestamp},v1=${sig}`,
    `t=${timestamp},v1=${sig},barepart`,
    `t=${timestamp},v1=${sig},`,
    `,t=${timestamp},v1=${sig}`,
  ]) {
    assert.equal(
      await verifyStripeSignatureWebCrypto(PAYLOAD, h, SECRET, nowMs),
      true,
      h,
    );
  }
});
