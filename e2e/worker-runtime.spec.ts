import { createHmac } from "node:crypto";
import fs from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Worker-runtime assertions (#204).
 *
 * Every other spec runs against `next dev`, where ORDERS and MASTERS are dev
 * shims rather than the deployed artifact's bindings. These three checks can
 * only pass when the thing under test is the built Worker with real bindings:
 *
 *   - the print-asset route streams the master from the R2 `MASTERS` binding,
 *     which a `next dev` server answers 503 for;
 *   - the Stripe webhook answers 400 (bad signature) rather than 503, which
 *     says STRIPE_WEBHOOK_SECRET reached the runtime as a binding;
 *   - the Prodigi webhook answers 401 without the token and 400 with it and a
 *     malformed CloudEvent, which says PRODIGI_WEBHOOK_TOKEN and ORDERS_DB
 *     reached the runtime (a missing ORDERS_DB is 503, before the parse).
 *
 * They therefore run only when the harness is pointed at the Worker, which
 * `ci.yml`'s `e2e-worker` job does by setting E2E_BASE_URL. Under the dev-server
 * job E2E_BASE_URL is unset, so this file skips with its reason instead of
 * failing on shims it was never meant to exercise.
 */

const workerBase = process.env.E2E_BASE_URL?.trim();
const isLocalWorker = (() => {
  if (!workerBase) return false;
  try {
    return new URL(workerBase).hostname === "localhost";
  } catch {
    return false;
  }
})();

test.describe("Worker runtime", () => {
  test.skip(
    !isLocalWorker,
    "runs only against the built Worker (E2E_BASE_URL=http://localhost:8787)",
  );

  test("print-asset streams the seeded master from the R2 binding", async ({
    request,
  }) => {
    const secret = process.env.PRINT_ASSET_HMAC_SECRET ?? "";
    expect(secret.length, "PRINT_ASSET_HMAC_SECRET must reach the job").toBeGreaterThan(0);

    // The master e2e/fixtures/worker-master.jpg is seeded at prints/dawn.jpg by
    // the job; "dawn" is the first catalog slug in src/lib/photos.ts.
    const slug = "dawn";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = createHmac("sha256", secret)
      .update(`v1.${slug}.${exp}`)
      .digest("hex");

    const res = await request.get(
      `/api/print-asset?slug=${slug}&exp=${exp}&sig=${sig}`,
    );
    // 503 (masters-unavailable) is the specific failure a missing MASTERS
    // binding produces; asserting 200 is what rules it out.
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");

    const body = await res.body();
    const fixture = fs.readFileSync(
      new URL("./fixtures/worker-master.jpg", import.meta.url),
    );
    expect(body.equals(fixture), "the served bytes must be the seeded master").toBe(
      true,
    );
  });

  test("print-asset refuses a bad signature with 401, not 503", async ({
    request,
  }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const res = await request.get(
      `/api/print-asset?slug=dawn&exp=${exp}&sig=${"a".repeat(64)}`,
    );
    expect(res.status()).toBe(401);
  });

  test("Stripe webhook rejects a bad signature with 400, not 503", async ({
    request,
  }) => {
    // 400 is `invalid-signature`: the secret is present and the body simply did
    // not verify. A 503 would mean STRIPE_WEBHOOK_SECRET never reached the
    // runtime, which is the deploy-only bug (#190) this job exists to catch.
    const res = await request.post("/api/webhooks/stripe", {
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      },
      data: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.status()).toBe(400);
  });

  test("Prodigi webhook requires the token, then reaches ORDERS_DB", async ({
    request,
  }) => {
    const token = process.env.PRODIGI_WEBHOOK_TOKEN ?? "";
    expect(token.length, "PRODIGI_WEBHOOK_TOKEN must reach the job").toBeGreaterThan(0);

    // Without the token: 401, not 503. A 503 is the route saying the token
    // binding is missing from the runtime.
    const unauthorized = await request.post("/api/webhooks/prodigi", {
      headers: { "content-type": "application/json" },
      data: "{}",
    });
    expect(unauthorized.status()).toBe(401);

    // With the token and a malformed CloudEvent: 400. The route checks the
    // ORDERS_DB binding before it parses, so a 400 — not a 503 — also proves the
    // D1 binding reached the runtime. The malformed body stops before the
    // Prodigi re-fetch, so no network call is made.
    const badEvent = await request.post(
      `/api/webhooks/prodigi?token=${encodeURIComponent(token)}`,
      {
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ specversion: "1.0" }),
      },
    );
    expect(badEvent.status()).toBe(400);
  });
});
