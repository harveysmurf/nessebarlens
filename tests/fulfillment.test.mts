import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Stripe from "stripe";
import {
  fulfillCheckoutSession,
} from "../src/application/fulfillment/fulfillment.ts";
import {
  decideFulfillment,
  expectedAmountCents,
  parseOrderRecord,
  parseRecipient,
  resolveDownload,
  type OrderRecord,
  type StripeShippingDetails,
} from "../src/domain/ordering/order-decision.ts";
import { masterKeyForSlug, type MastersBucket } from "../src/domain/catalog/master-key.ts";
import { getPhoto } from "../src/domain/catalog/photos.ts";
import { FRAME_FINISHES, PHYSICAL_FORMATS, PRINT_SIZES } from "../src/domain/pricing/sku-map.ts";
import { readStripeEvent } from "../src/infrastructure/stripe/stripe-event.ts";
import { eurToCents } from "../src/domain/pricing/pricing.ts";
import type { CreateProdigiOrder } from "../src/domain/ordering/print-provider.ts";
import type { AssetUrlSigner } from "../src/domain/ordering/asset-url-signer.ts";
import {
  downloadLinkForSession,
  readDownloadToken,
} from "../src/application/fulfillment/download-token.ts";
import { memoryOrdersStore } from "./fake-orders-store.mts";
import { SAMPLE_SLUG, SAMPLE_MASTER_KEY } from "./fixtures/sample-photo.mts";

const NOW = "2026-09-27T12:00:00.000Z";
const SESSION = "cs_test_abcdefgh";

process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";

// The one asset URL shape a stored physical order may carry after #245: the
// Worker's HMAC /api/print-asset, never a public placeholder.
const ASSET_URL = `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1799999999&sig=${"a".repeat(64)}`;

const SHIPPING: StripeShippingDetails = {
  name: "Test Buyer",
  address: {
    line1: "1 Harbor St",
    line2: "",
    city: "Nessebar",
    state: "",
    postal_code: "8230",
    country: "BG",
  },
};

function memoryKv(initial?: Record<string, string>) {
  return memoryOrdersStore({ store: initial });
}

const SITE_URL = "https://nessebarlens.com";

// The signer the routes wire from the container. Tests inject a fake so no
// secret or network is needed; the default returns the signed shape above.
const okSigner: AssetUrlSigner = {
  sign: async () => ASSET_URL,
  verify: async () => ({ ok: true, slug: SAMPLE_SLUG }),
};

function paidInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid" as string | null,
    currency: "eur" as string | null,
    amountTotal: 3000 as number | null,
    metadata: {
      photoSlug: SAMPLE_SLUG,
      format: "digital",
      size: "",
      frame: "",
      quoteEur: "30",
    } as Record<string, string> | null,
    shippingDetails: null as StripeShippingDetails | null,
    customerEmail: null as string | null,
    customerPhone: null as string | null,
    prodigiKeyConfigured: false,
    now: NOW,
    assetUrlSigner: okSigner,
    siteUrl: SITE_URL,
    ...overrides,
  };
}

function physicalMeta(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: "15",
    merchandiseEur: "15",
    shippingEur: "4.99",
    sku: "GLOBAL-FAP-12X16",
    ...extra,
  };
}

const okCreate: CreateProdigiOrder = async () => ({
  ok: true,
  value: {
    orderId: "ord_sandbox_1",
    stage: "InProgress",
    assetUrl: ASSET_URL,
  },
});

test("parseOrderRecord accepts the signed asset shape at any origin and rejects the retired placeholder (#110)", () => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://nessebarlens.com";
  const base = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid",
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1999,
    currency: "eur",
    reason: null,
    masterKey: null,
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: "buyer@example.com",
      phone: null,
    },
    prodigiOrderId: "ord_1",
    prodigiStage: "InProgress",
    updatedAt: NOW,
  };

  // #110: the read path checks shape, not origin, so a record written before a
  // domain move still parses instead of reading as a corrupt paid order. The
  // signing payload is origin-independent, so a re-hosted URL still verifies.
  // Same-origin is enforced at generation instead — see the generation test in
  // prodigi-order.test.mts.
  // The public placeholder path is retired (#245): a record carrying it is
  // rejected at any origin, so no old shape can read as a paid physical order.
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://old-domain.example/placeholders/dawn.jpg",
      }),
    ),
    null,
  );

  const movedSigned = parseOrderRecord(
    JSON.stringify({
      ...base,
      assetUrl:
        `https://old-domain.example/api/print-asset?slug=${SAMPLE_SLUG}&exp=1&sig=` +
        "a".repeat(64),
    }),
  );
  assert.ok(movedSigned, "a signed URL from the previous origin must parse");

  // Still rejected: a path the site does not serve, at any origin.
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://old-domain.example/account",
      }),
    ),
    null,
  );
  // Still rejected: not https.
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "http://old-domain.example/placeholders/dawn.jpg",
      }),
    ),
    null,
  );
  // Still rejected: a master reference.
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://old-domain.example/masters/prints/dawn.jpg",
      }),
    ),
    null,
  );

  // Rejected: the retired same-origin placeholder is no more a served shape
  // than a foreign one.
  assert.equal(
    parseOrderRecord(
      JSON.stringify({
        ...base,
        assetUrl: "https://nessebarlens.com/placeholders/dawn.jpg",
      }),
    ),
    null,
  );

  const okPrintAsset = parseOrderRecord(
    JSON.stringify({
      ...base,
      assetUrl:
        `https://nessebarlens.com/api/print-asset?slug=${SAMPLE_SLUG}&exp=1&sig=` +
        "a".repeat(64),
    }),
  );
  assert.ok(okPrintAsset);
});

test("amounts are cents: merchandise for digital, merchandise plus shipping for physical", () => {
  assert.equal(expectedAmountCents("digital", 30), 3000);
  assert.equal(expectedAmountCents("giclee", 15, 4.99), 1500 + 499);
  assert.equal(expectedAmountCents("framed", 13.48, 6), 1348 + 600);
});

test("parseRecipient requires a complete address", () => {
  assert.ok(parseRecipient(SHIPPING, "a@b.co", null));
  assert.equal(
    parseRecipient({ name: "x", address: { line1: "1", country: "BG" } }, null, null),
    null,
  );
});

test("parseRecipient rejects an empty postcode: Prodigi refuses one (sandbox: MustNotBeEmptyOrWhitespace)", () => {
  // Stripe's BG form lets the buyer leave the postcode blank. Prodigi's Create
  // Order requires recipient.address.postalOrZipCode and rejects "" and a
  // missing value alike, so inventing or blanking it would only move the
  // failure to Prodigi after payment. The order must stay paid-unfulfilled and
  // be surfaced to the customer instead.
  for (const postal_code of ["", "   ", null, undefined]) {
    assert.equal(
      parseRecipient(
        { name: "x", address: { line1: "1 Harbor St", city: "Nessebar", country: "BG", postal_code } },
        null,
        null,
      ),
      null,
    );
  }
});

test("digital payment with a matching total is paid and does not call Prodigi", async () => {
  let called = 0;
  const create: CreateProdigiOrder = async () => {
    called += 1;
      return { ok: true, value: { orderId: "x", stage: null, assetUrl: ASSET_URL } };
  };
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput(),
    store,
    createOrder: create,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.reason, null);
  assert.equal(called, 0);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.masterKey, getPhoto(SAMPLE_SLUG)?.imageKey);
  assert.equal(stored.prodigiOrderId, null);
  assert.equal(stored.terminal, true);
  assert.equal(stored.format, "digital");
});

test("a paid digital order with an email sends confirmation once (#117)", async () => {
  const store = memoryOrdersStore();
  const sent: string[] = [];
  const result = await fulfillCheckoutSession({
    ...paidInput({ customerEmail: "buyer@example.com" }),
    store,
    sendEmail: async (mail) => {
      sent.push(`${mail.kind}:${mail.to}`);
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(sent, ["order-confirmation:buyer@example.com"]);
  const record = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.ok(record.emailsSent.includes("order-confirmation"));

  const again = await fulfillCheckoutSession({
    ...paidInput({ customerEmail: "buyer@example.com" }),
    store,
    sendEmail: async (mail) => {
      sent.push(`${mail.kind}:${mail.to}`);
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(sent.length, 1, "redelivery must not re-send confirmation");
});

test("physical payment creates a Prodigi sandbox order and stores the id", async () => {
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 15 * 100 + 499,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: "buyer@example.com",
      metadata: physicalMeta(),
    }),
    store,
    createOrder: okCreate,
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.prodigiOrderId, "ord_sandbox_1");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.ok(stored);
  assert.equal(stored.status, "paid");
  assert.equal(stored.masterKey, null);
  assert.equal(stored.prodigiOrderId, "ord_sandbox_1");
  assert.equal(stored.prodigiStage, "InProgress");
  assert.equal(
    stored.assetUrl,
    ASSET_URL,
  );
  assert.equal(stored.recipient?.countryCode, "BG");
  assert.equal(stored.recipient?.email, "buyer@example.com");
  assert.equal(JSON.stringify(stored).includes(SAMPLE_MASTER_KEY), false);
});

test("missing shipping is a permanent stop without calling Prodigi", async () => {
  let called = 0;
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async () => {
      called += 1;
    return { ok: true, value: { orderId: "x", stage: null, assetUrl: ASSET_URL } };
    },
  });
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "missing-shipping");
  assert.equal(called, 0);
});

test("a Prodigi 400 is terminal and stores its own reason", async () => {
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async () => ({
      ok: false,
      kind: "client",
      reason: "prodigi-validation-error",
      message: "Prodigi order HTTP 400",
      status: 400,
    }),
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid-unfulfilled");
  assert.equal(result.body.reason, "prodigi-validation-error");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "prodigi-validation-error");
  assert.equal(stored?.prodigiOrderId, null);
});

test("a retryable Prodigi failure writes the paid order, answers 500, and retries on redelivery", async () => {
  // The unrecoverable case this replaces: a wrong sandbox key used to be
  // terminal, so the customer paid, the record was written as a terminal
  // duplicate, the webhook answered 200, and every later delivery hit the
  // duplicate branch — also 200. Now the record is written non-terminal with
  // its own reason (so a human sees the paid-but-unfulfilled order and owns the
  // refund), the webhook answers 5xx, and a redelivery re-attempts Prodigi
  // instead of short-circuiting.
  for (const reason of [
    "prodigi-auth-error",
    "prodigi-rate-limit",
    "prodigi-unavailable",
    "prodigi-asset-unconfigured",
    // A key that is not deployed yet is the same shape: retryable, and a
    // redelivery after the deploy places the order.
    "prodigi-unconfigured",
  ] as const) {
    const store = memoryOrdersStore();
    let fail = true;
    const createOrder: CreateProdigiOrder = async () =>
      fail
        ? {
            ok: false,
            kind: "server",
            reason,
            message: "transient",
            status: null,
          }
        : { ok: true, value: { orderId: "ord_fixed", stage: "InProgress", assetUrl: "https://nessebarlens.com/api/print-asset?x=1" } };

    const first = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      store,
      createOrder,
    });
    assert.equal(first.httpStatus, 500, reason);
    const stuck = parseOrderRecord((await store.getOrder(SESSION))!);
    assert.equal(stuck?.status, "paid-unfulfilled", reason);
    assert.equal(stuck?.reason, reason, reason);
    assert.equal(stuck?.terminal, false, reason);
    assert.equal(stuck?.prodigiOrderId, null, reason);

    // Stripe redelivers: the stored order is retried, not treated as a
    // duplicate, so fixing the key is what lands the print.
    fail = false;
    const retry = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      store,
      createOrder,
    });
    assert.equal(retry.httpStatus, 200, reason);
    assert.equal(retry.body.duplicate, undefined, reason);
    const fixed = parseOrderRecord((await store.getOrder(SESSION))!);
    assert.equal(fixed?.status, "paid", reason);
    assert.equal(fixed?.prodigiOrderId, "ord_fixed", reason);
    assert.equal(fixed?.terminal, true, reason);

    // And a further redelivery of a now-terminal order is a plain duplicate:
    // Prodigi must not be asked to place a second order for one payment.
    const again = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta(),
      }),
      store,
      createOrder,
    });
    assert.equal(again.body.duplicate, true, reason);
  }
});

test("a retryable record that is not a complete physical order is parked as bad-metadata", async () => {
  // buildRecord only writes awaiting-prodigi and the retryable reasons after
  // the size/frame/recipient checks pass, so a record in the retryable state is
  // normally a complete physical order. A tampered or legacy record can name a
  // retryable reason without that shape; the Prodigi trigger must park it
  // terminally instead of sending it to the client.
  const store = memoryOrdersStore({
    orders: {
      [SESSION]: JSON.stringify({
        v: 1,
        sessionId: SESSION,
        merchantReference: SESSION,
        terminal: false,
        status: "paid-unfulfilled",
        photoSlug: SAMPLE_SLUG,
        kind: "physical",
        format: "giclee",
        size: "30x40",
        frame: "",
        quoteEur: 15,
        amountTotal: 1999,
        currency: "eur",
        reason: "prodigi-unavailable",
        masterKey: null,
        recipient: null,
        prodigiOrderId: null,
        prodigiStage: null,
        assetUrl: null,
        updatedAt: NOW,
      }),
    },
  });
  let called = 0;
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async () => {
      called += 1;
      return {
        ok: true,
        value: { orderId: "x", stage: null, assetUrl: ASSET_URL },
      };
    },
  });
  assert.equal(called, 0, "a record without a recipient must not reach Prodigi");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.reason, "bad-metadata");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "bad-metadata");
  assert.equal(stored?.terminal, true);
});

test("a terminal Prodigi 400 is not retried on redelivery", async () => {
  const store = memoryOrdersStore();
  let calls = 0;
  const createOrder: CreateProdigiOrder = async () => {
    calls += 1;
    return {
      ok: false,
      kind: "client",
      reason: "prodigi-validation-error",
      message: "Prodigi order HTTP 400",
      status: 400,
    };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder,
  });
  assert.equal(first.httpStatus, 200);
  const second = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder,
  });
  assert.equal(second.body.duplicate, true);
  assert.equal(calls, 1);
});

test("a retry that ends in a validation error stores terminal:true (#106)", async () => {
  // The regression: a redelivery spreads the stored retryable record, which
  // carries terminal:false, and overwrote only the reason — so a permanently
  // failed order was stored as "still retryable". The flag has to be derived
  // from the reason, or a reconciler/operator view that trusts `terminal`
  // (#116) misreports it.
  const store = memoryOrdersStore();
  let fail = true;
  let calls = 0;
  const createOrder: CreateProdigiOrder = async () => {
    calls += 1;
    return fail
      ? {
          ok: false,
          kind: "server",
          reason: "prodigi-unavailable",
          message: "transient",
          status: null,
        }
      : {
          ok: false,
          kind: "client",
          reason: "prodigi-validation-error",
          message: "Prodigi order HTTP 400",
          status: 400,
        };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder,
  });
  assert.equal(first.httpStatus, 500);
  assert.equal(
    parseOrderRecord((await store.getOrder(SESSION))!)?.terminal,
    false,
    "the retryable failure is not terminal",
  );

  // Stripe redelivers, and this time Prodigi rejects the order outright.
  fail = false;
  const retry = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder,
  });
  assert.equal(retry.httpStatus, 200);
  assert.equal(calls, 2, "the retry really did call Prodigi");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "prodigi-validation-error");
  assert.equal(
    stored?.terminal,
    true,
    "a non-retryable reason must not be stored as retryable",
  );

  // And the flag and the reason now agree: a further redelivery is a plain
  // duplicate, not another Prodigi call: a reason that is not retryable ends
  // the session's automatic life, so a later redelivery cannot place the
  // order behind the customer's back.
  const again = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder,
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(calls, 2, "no third Prodigi call");
});

test("Prodigi server error returns 500 and records the paid order for a human", async () => {
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async () => ({
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi order HTTP 503",
      status: 503,
    }),
  });
  assert.equal(result.httpStatus, 500);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "prodigi-unavailable");
  assert.equal(stored?.terminal, false);
});

test("amount mismatch and missing shipping metadata are permanent stops", () => {
  const digitalWithShipping = decideFulfillment(
    paidInput({ amountTotal: 3000 + 1200 }),
  );
  assert.equal(digitalWithShipping.action, "write");
  if (digitalWithShipping.action === "write") {
    assert.equal(digitalWithShipping.record.reason, "amount-mismatch");
    assert.equal(digitalWithShipping.record.masterKey, null);
  }

  const physicalWithoutShippingMeta = decideFulfillment(
    paidInput({
      amountTotal: 1500,
      shippingDetails: SHIPPING,
      prodigiKeyConfigured: true,
      metadata: {
        photoSlug: SAMPLE_SLUG,
        format: "framed",
        size: "30x40",
        frame: "black",
        quoteEur: "15",
        merchandiseEur: "15",
      },
    }),
  );
  assert.equal(physicalWithoutShippingMeta.action, "write");
  if (physicalWithoutShippingMeta.action === "write") {
    assert.equal(physicalWithoutShippingMeta.record.reason, "bad-metadata");
  }

  const physicalWrongTotal = decideFulfillment(
    paidInput({
      amountTotal: 1500,
      shippingDetails: SHIPPING,
      prodigiKeyConfigured: true,
      metadata: physicalMeta({
        format: "framed",
        frame: "black",
        sku: "GLOBAL-CFPM-12X16",
      }),
    }),
  );
  assert.equal(physicalWrongTotal.action, "write");
  if (physicalWrongTotal.action === "write") {
    assert.equal(physicalWrongTotal.record.reason, "amount-mismatch");
  }
});

test("bad metadata, unknown photo, and unpaid sessions do not become downloads", () => {
  const bad = decideFulfillment(
    paidInput({ metadata: { photoSlug: SAMPLE_SLUG, format: "nope", quoteEur: "30" } }),
  );
  assert.equal(bad.action, "write");
  if (bad.action === "write") assert.equal(bad.record.reason, "bad-metadata");

  const unknown = decideFulfillment(
    paidInput({
      metadata: {
        photoSlug: "not-a-photo",
        format: "digital",
        size: "",
        frame: "",
        quoteEur: "30",
      },
    }),
  );
  assert.equal(unknown.action, "write");
  if (unknown.action === "write") {
    assert.equal(unknown.record.reason, "unknown-photo");
    assert.equal(unknown.record.masterKey, null);
  }

  const unpaid = decideFulfillment(paidInput({ paymentStatus: "unpaid" }));
  assert.deepEqual(unpaid, { action: "ignore", reason: "unpaid" });
});

test("a physical order stops the same way for missing quote or unknown photo", () => {
  // The two early stops are per-kind now: a physical order with no quote or an
  // unknown slug writes a physical bad-metadata / unknown-photo record, not a
  // digital or unknown one.
  const noQuote = decideFulfillment(
    paidInput({
      metadata: { photoSlug: SAMPLE_SLUG, format: "giclee", size: "30x40" },
    }),
  );
  assert.equal(noQuote.action, "write");
  if (noQuote.action === "write") {
    assert.equal(noQuote.record.reason, "bad-metadata");
    assert.equal(noQuote.record.kind, "physical");
    assert.equal(noQuote.record.format, "giclee");
  }

  const unknownPhoto = decideFulfillment(
    paidInput({
      metadata: {
        photoSlug: "not-a-photo",
        format: "giclee",
        size: "30x40",
        frame: "",
        quoteEur: "15",
        merchandiseEur: "15",
        shippingEur: "4.99",
      },
    }),
  );
  assert.equal(unknownPhoto.action, "write");
  if (unknownPhoto.action === "write") {
    assert.equal(unknownPhoto.record.reason, "unknown-photo");
    assert.equal(unknownPhoto.record.kind, "physical");
  }
});

test("a second delivery does not overwrite the first ORDERS record or call Prodigi again", async () => {
  const store = memoryOrdersStore();
  let calls = 0;
  const create: CreateProdigiOrder = async () => {
    calls += 1;
    return { ok: true, value: { orderId: "ord_1", stage: "InProgress", assetUrl: ASSET_URL } };
  };
  await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: create,
  });
  const first = await store.getOrder(SESSION);
  const again = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: create,
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(store.orderPuts.length, 1);
  assert.equal(calls, 1);
  assert.equal(await store.getOrder(SESSION), first);
});

test("download waits until ORDERS has a paid digital session, then streams MASTERS", async () => {
  const calls: string[] = [];
  const masters: MastersBucket = {
    async get(key) {
      calls.push(key);
      return {
        body: new ReadableStream(),
        size: 12,
        contentType: "image/jpeg",
      };
    },
  };

  const paid = parseOrderRecord(
    JSON.stringify(
      (
        decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
      ).record,
    ),
  );
  assert.ok(paid);
  const streamed = await resolveDownload(paid, masters);
  assert.equal(streamed.kind, "stream");
  if (streamed.kind === "stream") {
    assert.equal(streamed.filename, `${SAMPLE_SLUG}.jpg`);
    assert.equal(streamed.contentType, "image/jpeg");
  }
  assert.deepEqual(calls, [SAMPLE_MASTER_KEY]);

  const physicalKv = memoryKv();
  await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta({ format: "canvas", sku: "GLOBAL-CAN-12X16" }),
    }),
    store: physicalKv,
    createOrder: okCreate,
  });
  const physical = parseOrderRecord((await physicalKv.getOrder(SESSION))!);
  assert.ok(physical);
  assert.equal(physical.format, "canvas");
  assert.equal(physical.status, "paid");
  const blocked = await resolveDownload(physical, {
    async get() {
      throw new Error("masters must not be read");
    },
  });
  assert.equal(blocked.kind, "json");
  if (blocked.kind === "json") assert.equal(blocked.status, 403);
});

test("missing MASTERS binding and missing object are distinct", async () => {
  const paid = (
    decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
  ).record;
  const unavailable = await resolveDownload(paid, undefined);
  assert.equal(unavailable.kind, "json");
  if (unavailable.kind === "json") {
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error, "masters-unavailable");
  }
  const missing = await resolveDownload(paid, { async get() { return null; } });
  assert.equal(missing.kind, "json");
  if (missing.kind === "json") assert.equal(missing.status, 404);
});

function webhookPayload() {
  return JSON.stringify({
    id: "evt_test_webhook",
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: 1_700_000_000,
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION,
        object: "checkout.session",
        payment_status: "paid",
        currency: "eur",
        amount_total: 3000,
        metadata: {
          photoSlug: SAMPLE_SLUG,
          format: "digital",
          size: "",
          frame: "",
          quoteEur: "30",
        },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
}

test("webhook signature is checked against the raw body", async () => {
  const secret = "whsec_test_secret_value";
  const payload = webhookPayload();
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = await readStripeEvent(payload, header, secret);
  assert.equal(event.type, "checkout.session.completed");
  await assert.rejects(() => readStripeEvent(payload, header, "whsec_other"));
  await assert.rejects(() =>
    readStripeEvent(payload.replace(SAMPLE_SLUG, "dusk"), header, secret),
  );
});

test("web crypto verifies when constructEvent cannot run, and a bad signature does not fall through", async () => {
  const secret = "whsec_test_secret_value";
  const payload = webhookPayload();
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = await readStripeEvent(payload, header, secret, {
    construct() {
      throw new Error("createHmac is not a function");
    },
  });
  assert.equal(event.type, "checkout.session.completed");

  await assert.rejects(() =>
    readStripeEvent(payload.replace(SAMPLE_SLUG, "dusk"), header, secret, {
      construct() {
        throw new Error("createHmac is not a function");
      },
    }),
  );

  const stale = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: Math.floor(Date.now() / 1000) - 1000,
  });
  await assert.rejects(() =>
    readStripeEvent(payload, stale, secret, {
      construct() {
        throw new Error("createHmac is not a function");
      },
    }),
  );

  await assert.rejects(() =>
    readStripeEvent(payload, header, secret, {
      construct() {
        throw new Stripe.errors.StripeSignatureVerificationError(header, payload, {
          message: "No signatures found matching the expected signature for payload.",
        });
      },
    }),
  );
});

test("webhook + download routes still do not call Prodigi; order module is the only fetch site", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const rel of [
    "src/application/fulfillment/fulfillment.ts",
    "src/domain/ordering/order-decision.ts",
    "src/domain/catalog/master-key.ts",
    "src/application/fulfillment/print-asset.ts",
    "src/domain/pricing/crypto-hex.ts",
    "src/infrastructure/stripe/stripe-event.ts",
    "src/infrastructure/cloudflare/worker-bindings.ts",
    "src/app/api/webhooks/stripe/route.ts",
    "src/app/api/download/route.ts",
    "src/app/api/print-asset/route.ts",
  ]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(src.includes("fetch("), false, rel);
    assert.equal(src.includes("api.sandbox.prodigi.com"), false, rel);
    assert.equal(src.includes("api.prodigi.com"), false, rel);
  }
  const order = fs.readFileSync(path.join(root, "src/infrastructure/prodigi/prodigi-order.ts"), "utf8");
  assert.equal(order.includes("prodigiUrl"), true);
  assert.equal(order.includes("prodigiConfig"), true);
  assert.equal(order.includes("assertNoMasterLeak"), true);
  // The adapter no longer signs: the application signs the asset URL and passes
  // it in, so the Prodigi adapter cannot reach back into application/print-asset.
  assert.equal(order.includes("signPrintAssetUrl"), false);
  const fulfillment = fs.readFileSync(
    path.join(root, "src/application/fulfillment/fulfillment.ts"),
    "utf8",
  );
  assert.equal(fulfillment.includes("signPrintAssetUrl"), true);
  const config = fs.readFileSync(
    path.join(root, "src/infrastructure/prodigi/prodigi-config.ts"),
    "utf8",
  );
  assert.equal(config.includes("https://api.sandbox.prodigi.com"), true);
  assert.equal(config.includes("https://api.prodigi.com"), true);
  assert.equal(masterKeyForSlug(SAMPLE_SLUG), getPhoto(SAMPLE_SLUG)?.imageKey);
  assert.equal(masterKeyForSlug("not-a-photo"), null);
});

test("stripe client uses fetch http client for Workers", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/infrastructure/stripe/stripe.ts"),
    "utf8",
  );
  assert.equal(src.includes("Stripe.createFetchHttpClient()"), true);
});

test("fulfillment metadata validation tracks the sku-map lists", () => {
  // Every combination the SKU table can build must pass metadata validation,
  // and anything outside the lists must be parked as bad-metadata.
  for (const format of PHYSICAL_FORMATS) {
    for (const size of PRINT_SIZES) {
      for (const frame of format === "framed" ? FRAME_FINISHES : [""]) {
        const decided = decideFulfillment(
          paidInput({
            amountTotal: 1999,
            metadata: {
              photoSlug: SAMPLE_SLUG,
              format,
              size,
              frame,
              quoteEur: "15",
              merchandiseEur: "15",
              shippingEur: "4.99",
              sku: "GLOBAL-FAP-12X16",
            },
            shippingDetails: SHIPPING,
          }),
        );
        assert.equal(decided.action, "write", `${format}/${size}/${frame}`);
        assert.notEqual(
          (decided as { record: OrderRecord }).record.reason,
          "bad-metadata",
        );
      }
    }
  }

  for (const size of ["99x99", "", "40x30"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: SAMPLE_SLUG, format: "giclee", size, frame: "", quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `size ${size} should not be fulfillable`,
    );
  }

  for (const format of ["poster", "", "print"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: SAMPLE_SLUG, format, size: "30x40", frame: "", quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `format ${format} should not be fulfillable`,
    );
  }

  for (const frame of ["gold", "silver"]) {
    const decided = decideFulfillment(
      paidInput({
            amountTotal: 1999,
        metadata: { photoSlug: SAMPLE_SLUG, format: "framed", size: "30x40", frame, quoteEur: "15" },
        shippingDetails: SHIPPING,
      }),
    );
    assert.equal(
      (decided as { record: OrderRecord }).record.reason,
      "bad-metadata",
      `frame ${frame} should not be fulfillable`,
    );
  }
});

test("the fulfillment pair reuses the pricing/sku-map types instead of redeclaring them", () => {
  const root = path.join(import.meta.dirname, "..");
  const decision = fs.readFileSync(path.join(root, "src/domain/ordering/order-decision.ts"), "utf8");
  const effects = fs.readFileSync(path.join(root, "src/application/fulfillment/fulfillment.ts"), "utf8");
  const both = decision + effects;

  // The unions must be imported from their owners, not restated: a private copy
  // would leave the order validator behind when a format is added. The two
  // halves narrow differently — order-decision builds the discriminated union,
  // fulfillment narrows it back down on the way to Prodigi — so the names have
  // to arrive from pricing (the label/format unions) or sku-map's predicates
  // (the allow-lists).
  const pricingImports = [...both.matchAll(/import (type )?\{([^}]*)\} from "[^"]*\/pricing\/pricing"/g)]
    .map((m) => m[2]!)
    .join(",");
  assert.ok(pricingImports.length > 0, "the pair must import from pricing.ts");
  for (const name of ["FrameFinish", "PrintFormat"]) {
    assert.ok(
      pricingImports.includes(name),
      `${name} must be imported from pricing.ts`,
    );
  }
  assert.equal(
    both.includes('type PrintFormat = "giclee" | "framed" | "canvas" | "digital"'),
    false,
  );
  // No alias arrays re-wrapping the sku-map lists.
  assert.equal(/const SIZES\s*:/.test(both), false);
  assert.equal(/const FRAMES\s*:/.test(both), false);
  // The allow-list is read through sku-map's predicates, not through a local
  // alias array. The alias was not itself the bug -- it pointed at the shared
  // list -- but the two format guards each cast their way through it, so the
  // cast rather than the check decided what a stored format could be. Reading
  // isSellableFormat narrows once and cannot be pointed at a different list.
  assert.ok(
    decision.includes("isSellableFormat"),
    "order-decision must validate formats with sku-map's isSellableFormat",
  );
  assert.ok(
    decision.includes("isPhysicalFormat"),
    "order-decision must split physical from digital with sku-map's predicate",
  );
  assert.ok(
    effects.includes("isPrintSize"),
    "fulfillment must narrow the size with sku-map's isPrintSize, not a cast",
  );
  assert.ok(
    effects.includes("isFrameFinishValue"),
    "fulfillment must narrow the frame with sku-map's isFrameFinishValue, not a cast",
  );
  assert.equal(
    /const FORMATS\s*:/.test(both),
    false,
    "no local alias of the sellable format list",
  );
  assert.equal(
    /as readonly string\[\]/.test(both),
    false,
    "no cast-through-string[] membership test in the pair",
  );
  // The four parsed domain fields fulfillment used to cast must not be cast
  // back now that the record is a discriminated union: `kind` does the
  // narrowing, and the size/frame/recipient checks are guards.
  for (const cast of [
    "as PhysicalFormat",
    "as PrintSize",
    "as FrameFinish",
    "recipient!",
  ]) {
    assert.equal(effects.includes(cast), false, `fulfillment still casts ${cast}`);
  }
  // SELLABLE_FORMATS is the one place "digital" joins the physical formats.
  assert.equal(
    /\[\.\.\.PHYSICAL_FORMATS, "digital"\]/.test(both),
    false,
    'do not re-spell [...PHYSICAL_FORMATS, "digital"] in the pair',
  );
});

test("EUR→cents rounding is eurToCents everywhere, fractional inputs included", () => {
  // Stripe, the webhook amount check and the stored record all have to agree
  // on the rounding, or a paid session fails its own amount check.
  assert.equal(expectedAmountCents("digital", 15.005), eurToCents(15.005));
  assert.equal(expectedAmountCents("giclee", 15, 4.999), 1500 + 500);
  assert.equal(expectedAmountCents("canvas", 0.001, 0.001), 0);
  assert.equal(eurToCents(15.005), 1501);
});

test("parseOrderRecord accepts cent-exact amounts and rejects sub-cent ones", () => {
  const base = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: null,
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const record = (patch: Record<string, unknown>) =>
    parseOrderRecord(JSON.stringify({ ...base, ...patch }));

  assert.equal(record({})?.quoteEur, 15);
  assert.equal(record({ quoteEur: 15.5 })?.quoteEur, 15.5);
  // 15.001 EUR is not a whole number of cents — Stripe would reject it.
  assert.equal(record({ quoteEur: 15.001 }), null);
  assert.equal(record({ quoteEur: -1 }), null);
  assert.equal(record({ quoteEur: Number.NaN }), null);
  assert.equal(record({ quoteEur: "15" }), null);
  assert.equal(record({ amountTotal: 1500.5 }), null);
});

test("resolveDownload is a gate, and every rejection path is distinguishable", async () => {
  const digitalPaid = (patch: Partial<OrderRecord> = {}): OrderRecord => {
    const base = (
      decideFulfillment(paidInput()) as { action: "write"; record: OrderRecord }
    ).record;
    assert.equal(base.format, "digital");
    return { ...base, ...patch };
  };
  // httpMetadata is where R2 puts the content type (#109): a hand-written
  // `contentType` on the object is not a field R2 has, and reading one is a
  // silent `undefined` that falls back to image/jpeg for every master.
  const bytes = (contentType?: string): MastersBucket => ({
    async get() {
      return {
        body: new ReadableStream(),
        size: 7,
        httpMetadata: contentType ? { contentType } : undefined,
      };
    },
  });

  // 1. A physical order is not a download at all, and the bucket is untouched.
  let touched = false;
  const physical = digitalPaid({ kind: "physical", format: "giclee", size: "30x40" });
  const refused = await resolveDownload(physical, {
    async get() {
      touched = true;
      return null;
    },
  });
  assert.deepEqual(refused, {
    kind: "json",
    status: 403,
    body: { error: "not-a-digital-download" },
  });
  assert.equal(touched, false, "a physical order must never read MASTERS");

  // 2. Unfulfilled digital orders explain themselves with their stored reason.
  for (const reason of ["prodigi-error", "unfulfilled"] as const) {
    const unfulfilled = digitalPaid({ status: "paid-unfulfilled", reason, masterKey: null });
    const result = await resolveDownload(unfulfilled, undefined);
    assert.deepEqual(result, {
      kind: "json",
      status: 409,
      body: { error: "download-unavailable", reason },
    });
  }

  // 3. paid but masterKey null is still 409, not a 500 on a null key.
  const noKey = await resolveDownload(digitalPaid({ masterKey: null }), undefined);
  assert.equal(noKey.kind === "json" && noKey.status, 409);

  // 4. A throwing bucket is a 503 that does not escape.
  const throwing = await resolveDownload(digitalPaid(), {
    async get() {
      throw new Error("R2 down");
    },
  });
  assert.deepEqual(throwing, {
    kind: "json",
    status: 503,
    body: { error: "masters-unavailable" },
  });

  // 5. The filename comes from the slug, with a safe fallback if it is not one.
  const odd = digitalPaid({ photoSlug: "Not A Slug", masterKey: SAMPLE_MASTER_KEY });
  const oddStream = await resolveDownload(odd, bytes("image/jpeg"));
  assert.equal(oddStream.kind === "stream" && oddStream.filename, "download.jpg");
  // contentType falls back to image/jpeg when the bucket does not say.
  const noType = await resolveDownload(digitalPaid(), bytes(undefined));
  assert.equal(noType.kind === "stream" && noType.contentType, "image/jpeg");
  const otherType = await resolveDownload(digitalPaid(), bytes("image/png"));
  assert.equal(otherType.kind === "stream" && otherType.contentType, "image/png");
});

test("the webhook ignores anything that is not a paid, well-formed session", async () => {
  // Not a Stripe session id at all.
  for (const sessionId of ["nope", "cs_123", "cs_test_", "cs_prod_12345678"]) {
    assert.deepEqual(decideFulfillment(paidInput({ sessionId })), {
      action: "ignore",
      reason: "invalid-session-id",
    });
  }
  // Right shape, not paid.
  for (const paymentStatus of ["unpaid", "no_payment_required", null, "PAID"]) {
    assert.deepEqual(decideFulfillment(paidInput({ paymentStatus })), {
      action: "ignore",
      reason: "unpaid",
    });
  }
  // The ignore decision is what the route answers with: 200 + received, so
  // Stripe stops retrying, and nothing is written.
  const store = memoryOrdersStore();
  const ignored = await fulfillCheckoutSession({ ...paidInput({ sessionId: "nope" }), store });
  assert.deepEqual(ignored, { httpStatus: 200, body: { received: true, ignored: "invalid-session-id" } });
  const unpaid = await fulfillCheckoutSession({ ...paidInput({ paymentStatus: "unpaid" }), store });
  assert.deepEqual(unpaid, { httpStatus: 200, body: { received: true, ignored: "unpaid" } });
  assert.deepEqual(store.orderPuts, [], "an ignored session must not write ORDERS");
});

test("a non-framed format carrying a frame is bad metadata, not a silent drop", () => {
  for (const [format, frame] of [
    ["giclee", "black"],
    ["canvas", "brown"],
    ["giclee", " "],
  ] as const) {
    const decided = decideFulfillment(
      paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        metadata: physicalMeta({ format, frame }),
      }),
    );
    assert.equal(decided.action, "write");
    const record = (decided as { record: OrderRecord }).record;
    assert.equal(record.reason, "bad-metadata", `${format}/${frame}`);
    assert.equal(record.status, "paid-unfulfilled");
    assert.equal(record.recipient, null, "a rejected order keeps no shipping data");
  }
});

test("a physical order without shipping stops as missing-shipping, before Prodigi", async () => {
  const decided = decideFulfillment(
    paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
  );
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.reason, "missing-shipping");
  assert.equal(record.status, "paid-unfulfilled");

  let created = 0;
  const store = memoryOrdersStore();
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: null,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async (input) => {
      created++;
      return okCreate(input);
    },
  });
  assert.equal(created, 0, "Prodigi must not be called for an unfulfillable order");
  assert.equal(result.httpStatus, 200);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "missing-shipping");
});

test("parseOrderRecord rejects a stored recipient it cannot vouch for", () => {
  const shell = {
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: SAMPLE_SLUG,
    format: "giclee",
    size: "30x40",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: "prodigi-error",
    masterKey: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
  const good = {
    ...shell,
    recipient: {
      name: "Test Buyer",
      line1: "1 Harbor St",
      line2: "",
      city: "Nessebar",
      state: "",
      postcode: "8230",
      countryCode: "BG",
      email: null,
      phone: null,
    },
  };
  assert.ok(parseOrderRecord(JSON.stringify(good)));
  for (const patch of [
    { email: 42 },
    { phone: {} },
    { countryCode: "bulgaria" },
    { countryCode: "B" },
    { city: 7 },
    { line1: null },
    { name: 1 },
    { state: 5 },
    { postcode: [] },
    { countryCode: null },
  ]) {
    const record = { ...good, recipient: { ...good.recipient, ...patch } };
    assert.equal(parseOrderRecord(JSON.stringify(record)), null, JSON.stringify(patch));
  }
  // A missing recipient field is not the same as a malformed one.
  const withoutLine2: Record<string, unknown> = { ...good.recipient };
  delete withoutLine2.line2;
  assert.equal(parseOrderRecord(JSON.stringify({ ...good, recipient: withoutLine2 })), null);
  assert.ok(parseOrderRecord(JSON.stringify({ ...good, recipient: null })));
});

test("a physical order with shipping but no Prodigi key waits, retryably, for the key", async () => {
  // This was the silent-money-losing case. The record was written with the
  // shell's terminal:true and the reason "prodigi-key-unset", so the webhook
  // answered 200, Stripe never redelivered, and a customer who paid for a print
  // got nothing — with no log line anywhere. A missing key is deploy config
  // and is fixable inside Stripe's redelivery window, so the order has to stay
  // eligible for a retry.
  const decided = decideFulfillment(
    paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: false,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
  );
  const record = (decided as { record: OrderRecord }).record;
  assert.equal(record.reason, "prodigi-unconfigured");
  assert.equal(record.status, "paid-unfulfilled");
  assert.equal(record.terminal, false, "a redelivery must be able to retry it");
  // The address is kept: it is valid, only the credential is missing.
  assert.equal(record.recipient?.city, "Nessebar");

  let created = 0;
  const store = memoryOrdersStore();
  // Stands in for the real client, which returns this exact failure without
  // contacting Prodigi (pinned in prodigi-order.test.mts).
  const unconfiguredCreate: CreateProdigiOrder = async () => {
    created++;
    return {
      ok: false,
      kind: "server",
      reason: "prodigi-unconfigured",
      message: "PRODIGI_SANDBOX_API_KEY is not set",
      status: null,
    };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: false,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: unconfiguredCreate,
  });
  assert.equal(created, 1);
  // Not a duplicate and not a success: 5xx, so Stripe keeps redelivering.
  assert.equal(first.httpStatus, 500);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.reason, "prodigi-unconfigured");
  assert.equal(stored?.terminal, false);
  assert.equal(stored?.recipient?.city, "Nessebar");

  // The key is deployed; the redelivery places the order. One payment, one
  // Prodigi order — and the same session id is the idempotency key, so even if
  // Prodigi had already accepted the first POST it returns that same order.
  const second = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: okCreate,
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.duplicate, undefined);
  const placed = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(placed?.status, "paid");
  assert.equal(placed?.prodigiOrderId, "ord_sandbox_1");
  assert.equal(placed?.terminal, true);
});

// The caps parseRecipient applies are a shipping-API contract, not style. Each
// is asserted at its own boundary so a change to one is a deliberate edit that
// names the field, rather than a shared "field length" that moves in silence.
test("parseRecipient truncates each field at its own cap", () => {
  const at = (n: number) => "x".repeat(n);
  const over = (n: number) => at(n) + "x";

  const recipient = parseRecipient(
    {
      name: over(128),
      address: {
        line1: over(128),
        line2: over(128),
        city: over(128),
        state: over(128),
        postal_code: over(32),
        country: "BG",
      },
    },
    `${over(254)}@example.com`,
    over(32),
  )!;

  // Address lines are 128.
  assert.equal(recipient.name, at(128));
  assert.equal(recipient.line1, at(128));
  assert.equal(recipient.line2, at(128));
  assert.equal(recipient.city, at(128));
  assert.equal(recipient.state, at(128));
  // Postcode and phone are both 32 today, but they are separate caps: raising
  // either one alone must break the assertion above, which is the point.
  assert.equal(recipient.postcode, at(32));
  assert.equal(recipient.phone, at(32));
  // Email is 254.
  assert.equal(recipient.email!.length, 254);
});

test("an unsignable master fails the order closed, before any network call", async () => {
  // No HMAC secret means no real asset URL, and a placeholder would ship the
  // ~41KB low-res stand-in to a customer who paid for a print. Fail closed with
  // the asset-specific reason and 5xx, so Stripe redelivers once the secret is
  // deployed.
  const store = memoryOrdersStore();
  let created = 0;
  const create: CreateProdigiOrder = async () => {
    created++;
    return {
      ok: true,
      value: { orderId: "ord_never", stage: null, assetUrl: ASSET_URL },
    };
  };
  const nullSigner: AssetUrlSigner = {
    sign: async () => null,
    verify: async () => ({
      ok: false,
      status: 503,
      error: "print-asset-unavailable",
    }),
  };
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: create,
    assetUrlSigner: nullSigner,
  });
  assert.equal(created, 0, "Prodigi must never be contacted");
  assert.equal(result.httpStatus, 500);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!);
  assert.equal(stored?.status, "paid-unfulfilled");
  assert.equal(stored?.reason, "prodigi-asset-unconfigured");
  assert.equal(stored?.terminal, false, "a redelivery must retry it");
});

// ---- download tokens (#111) ----

test("a paid digital order is issued exactly one download token", async () => {
  const store = memoryOrdersStore();
  await fulfillCheckoutSession({ ...paidInput(), store, createOrder: okCreate });
  const link = await downloadLinkForSession(store, SESSION);
  assert.match(link!, /^\/api\/download\?token=[0-9a-f]{32}$/);
  const record = await readDownloadToken(store, SESSION);
  assert.equal(record?.remaining, 5);
  assert.equal(record?.sessionId, SESSION);
});

test("the configured limits are the ones the token is issued under", async () => {
  const store = memoryOrdersStore();
  await fulfillCheckoutSession({
    ...paidInput(),
    store,
    createOrder: okCreate,
    downloadLimits: { ttlSeconds: 3600, maxDownloads: 1 },
  });
  const record = await readDownloadToken(store, SESSION);
  assert.equal(record?.remaining, 1);
});

test("a print is issued no token, and neither is an unfulfilled digital order", async () => {
  // A token for a print is a link that 403s; a token for a paid-but-unfulfilled
  // digital order is a link whose only outcome is a 409. Neither is a download.
  const printed = memoryKv();
  await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 15 * 100 + 499,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: "buyer@example.com",
      metadata: physicalMeta(),
    }),
    store: printed,
    createOrder: okCreate,
  });
  assert.equal(await readDownloadToken(printed, SESSION), null);

  const badMetadata = memoryKv();
  await fulfillCheckoutSession({
    ...paidInput({ metadata: { ...paidInput().metadata, photoSlug: "" } }),
    store: badMetadata,
    createOrder: okCreate,
  });
  assert.equal(await readDownloadToken(badMetadata, SESSION), null);
});

test("a redelivery repairs a paid digital order that has a record but no token", async () => {
  // The failure this covers: the order was stored, the token write failed, and
  // Stripe redelivers. Answering "duplicate, already handled" without minting
  // would leave a paid customer with no way to their file, permanently.
  const store = memoryOrdersStore();
  await fulfillCheckoutSession({ ...paidInput(), store, createOrder: okCreate });
  store.indexes.set(SESSION, "corrupt");
  assert.equal(await readDownloadToken(store, SESSION), null);

  const again = await fulfillCheckoutSession({ ...paidInput(), store, createOrder: okCreate });
  assert.equal(again.body.duplicate, true);
  assert.ok(await readDownloadToken(store, SESSION), "the redelivery minted a token");
});

test("a token write failure does not fail an already-paid order", async () => {
  // The money is taken and the order is stored; losing a convenience record
  // must not answer 5xx, or Stripe redelivers a fulfilled order forever.
  const base = memoryOrdersStore();
  const store = {
    ...base,
    async putDownloadToken() {
      throw new Error("store write failed");
    },
  };
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args[0]);
  try {
    const result = await fulfillCheckoutSession({ ...paidInput(), store, createOrder: okCreate });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.status, "paid");
    assert.ok(parseOrderRecord((await store.getOrder(SESSION))!));
    assert.match(
      JSON.stringify(errors),
      /order\.download-token-failed/,
      "the failure is logged, not swallowed",
    );
  } finally {
    console.error = realError;
  }
});

/* --- customer email (#117) --------------------------------------------- */

test("a redelivery that lands the print falls back to the stored recipient email", async () => {
  // Stripe's customer_email is only set when the buyer typed one, and a
  // redelivery may carry a session without it. The stored record still holds
  // the address parseRecipient accepted, and that is the only copy of a mail
  // address we have — dropping it would silently lose the shipped mail.
  const store = memoryOrdersStore();
  const first = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: "buyer@example.com",
      metadata: physicalMeta(),
    }),
    store,
    createOrder: async () => ({
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi order HTTP 503",
      status: 503,
    }),
    sendEmail: async () => ({ ok: true, message: "sent" }),
  });
  assert.equal(first.httpStatus, 500);
  assert.ok(
    !(parseOrderRecord((await store.getOrder(SESSION))!)!.emailsSent.length > 0),
    "a retryable miss claims nothing",
  );

  const sent: string[] = [];
  const second = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: null,
      metadata: physicalMeta(),
    }),
    store,
    createOrder: okCreate,
    sendEmail: async (mail) => {
      sent.push(`${mail.kind}:${mail.to}`);
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(second.httpStatus, 200);
  assert.deepEqual(sent, ["order-confirmation:buyer@example.com"]);
});

test("a kind already in emailsSent is not claimed or sent twice", async () => {
  // Stripe redelivers a paid event, so the terminal write can run twice for the
  // same order. The claim lives in the record, so a second run sees the kind
  // and must skip the send — otherwise the customer gets two mails.
  const store = memoryOrdersStore();
  const sent: string[] = [];
  const sendEmail = async (mail: { kind: string }) => {
    sent.push(mail.kind);
    return { ok: true, message: "sent" };
  };
  const first = await fulfillCheckoutSession({
    ...paidInput({ customerEmail: "buyer@example.com" }),
    store,
    sendEmail,
  });
  assert.equal(first.httpStatus, 200);
  assert.deepEqual(sent, ["order-confirmation"]);
  const redelivery = await fulfillCheckoutSession({
    ...paidInput({ customerEmail: "buyer@example.com" }),
    store,
    sendEmail,
  });
  assert.equal(redelivery.httpStatus, 200, "the redelivery is not an error");
  assert.deepEqual(sent, ["order-confirmation"], "the claim was already taken on the first run");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(stored.emailsSent, ["order-confirmation"], "the claim is not duplicated");
});

test("an order with no address at all still completes and claims nothing", async () => {
  const store = memoryOrdersStore();
  const sent: string[] = [];
  const result = await fulfillCheckoutSession({
    ...paidInput(),
    store,
    sendEmail: async (mail) => {
      sent.push(mail.kind);
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "paid");
  assert.deepEqual(sent, [], "there is nowhere to send a confirmation");
  const stored = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(stored.emailsSent, [], "an unmailed order claims nothing");
});

test("a retryable Prodigi failure sends no mail: the order may still land", async () => {
  // The apology email is keyed off OUR terminal write. A retryable miss is not
  // one — a redelivery may still place the order — so mailing here would tell
  // a customer their order failed when it has not.
  const store = memoryOrdersStore();
  const sent: string[] = [];
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await fulfillCheckoutSession({
      ...paidInput({
        amountTotal: 1999,
        prodigiKeyConfigured: true,
        shippingDetails: SHIPPING,
        customerEmail: "buyer@example.com",
        metadata: physicalMeta(),
      }),
      store,
      createOrder: async () => ({
        ok: false,
        kind: "server",
        reason: "prodigi-unavailable",
        message: "Prodigi order HTTP 503",
        status: 503,
      }),
      sendEmail: async (mail) => {
        sent.push(mail.kind);
        return { ok: true, message: "sent" };
      },
    });
    assert.equal(result.httpStatus, 500, "a retryable miss still answers 5xx to Stripe");
    assert.equal(result.body.error, "prodigi-unavailable", "the stored reason names the cause");
  } finally {
    console.error = original;
  }
  assert.deepEqual(sent, []);
  const stored = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.deepEqual(stored.emailsSent, []);
  assert.ok(lines.some((l) => l.includes("order.unfulfilled")));
});

test("a sendEmail that reports failure is logged and leaves the write and the 200 alone", async () => {
  const store = memoryOrdersStore();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await fulfillCheckoutSession({
      ...paidInput({ customerEmail: "buyer@example.com" }),
      store,
      sendEmail: async () => ({ ok: false, message: "Resend HTTP 500" }),
    });
    assert.equal(result.httpStatus, 200, "a mail provider hiccup is not a fulfillment failure");
  } finally {
    console.error = original;
  }
  assert.ok(lines.some((l) => l.includes("email.failed")));
  assert.ok(lines.some((l) => l.includes("Resend HTTP 500")));
  const stored = parseOrderRecord((await store.getOrder(SESSION))!)!;
  assert.ok(stored.emailsSent.includes("order-confirmation"));
  assert.equal(stored.status, "paid");
});

test("a sendEmail that throws is contained, not propagated to Stripe", async () => {
  const store = memoryOrdersStore();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    const result = await fulfillCheckoutSession({
      ...paidInput({ customerEmail: "buyer@example.com" }),
      store,
      sendEmail: async () => {
        throw new Error("resend exploded");
      },
    });
    assert.equal(result.httpStatus, 200);
  } finally {
    console.error = original;
  }
  assert.ok(lines.some((l) => l.includes("resend exploded")));
});

test("a sendEmail that throws a non-Error is logged as email-threw", async () => {
  const store = memoryOrdersStore();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    await fulfillCheckoutSession({
      ...paidInput({ customerEmail: "buyer@example.com" }),
      store,
      sendEmail: async () => {
        throw "just a string";
      },
    });
  } finally {
    console.error = original;
  }
  assert.ok(lines.some((l) => l.includes("email-threw")));
});

test("a terminal unfulfilled order mails once, naming the kind not the session", async () => {
  const store = memoryOrdersStore();
  const mails: Array<{ kind: string; subject: string; text: string }> = [];
  const fail: CreateProdigiOrder = async () => ({
    ok: false,
    kind: "client",
    reason: "prodigi-validation-error",
    message: "Prodigi order HTTP 400",
    status: 400,
  });
  const input = paidInput({
    amountTotal: 1999,
    prodigiKeyConfigured: true,
    shippingDetails: SHIPPING,
    customerEmail: "buyer@example.com",
    metadata: physicalMeta(),
  });
  const first = await fulfillCheckoutSession({
    ...input,
    store,
    createOrder: fail,
    sendEmail: async (mail) => {
      mails.push({ kind: mail.kind, subject: mail.subject, text: mail.text });
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(first.httpStatus, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0]!.kind, "order-unfulfilled");
  assert.match(mails[0]!.text, new RegExp(`Reference: ${SESSION.slice(-8).toUpperCase()}`));

  const again = await fulfillCheckoutSession({
    ...input,
    store,
    createOrder: fail,
    sendEmail: async (mail) => {
      mails.push({ kind: mail.kind, subject: mail.subject, text: mail.text });
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(again.httpStatus, 200);
  assert.equal(mails.length, 1, "a terminal failure must not apologise twice");
});

test("a lost lock on an emailed write sends nothing (#117)", async () => {
  const base = memoryOrdersStore();
  // A first, failed-but-stored run leaves a retryable record; the redelivery
  // then loses the race. The loser must not send the customer's mail.
  await fulfillCheckoutSession({
    ...paidInput({ customerEmail: "buyer@example.com" }),
    store: base,
    createOrder: async () => ({
      ok: false,
      kind: "server",
      reason: "prodigi-unavailable",
      message: "Prodigi order HTTP 503",
      status: 503,
    }),
  });
  const sent: string[] = [];
  const locked = {
    ...base,
    async transitionOrder() {
      return false;
    },
  };
  const result = await fulfillCheckoutSession({
    ...paidInput({
      amountTotal: 1999,
      prodigiKeyConfigured: true,
      shippingDetails: SHIPPING,
      customerEmail: "buyer@example.com",
      metadata: physicalMeta(),
    }),
    store: locked,
    createOrder: okCreate,
    sendEmail: async (mail) => {
      sent.push(mail.kind);
      return { ok: true, message: "sent" };
    },
  });
  assert.equal(result.body.duplicate, true);
  assert.deepEqual(sent, []);
});
