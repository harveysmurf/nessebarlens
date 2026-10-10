/**
 * Operator alert port + Resend adapter + dispatch (#309).
 *
 * Covers:
 * - The port type contract: a generic, event-keyed alert shape whose
 *   `details` carry the variant-specific facts, and `raise` returning void.
 * - buildAlertEmail: renders event/summary/details/sessionId into the email.
 * - createOperatorAlerts: unconfigured (missing key or recipient) → undefined.
 * - EmailOperatorAlerts.raise: Resend HTTP shape, and that provider failures
 *   throw (so the dispatch wrapper classifies them as operator-alert.failed /
 *   operator-alert.threw).
 * - raiseOperatorAlert dispatch: undelivered / failed / threw / never
 *   propagates.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  OperatorAlert,
  OperatorAlerts,
} from "../src/application/ports/operator-alerts.ts";
import {
  buildAlertEmail,
  createOperatorAlerts,
  EmailOperatorAlerts,
} from "../src/infrastructure/alerts/email-operator-alerts.ts";
import { raiseOperatorAlert } from "../src/application/operator-alert.ts";

const PRODIGI_ID = "ord_abc123";
const SESSION = "cs_test_abcdefgh";

function cancelFailedAlert(
  overrides: Partial<OperatorAlert> = {},
): OperatorAlert {
  return {
    event: "order.prodigi-cancel-failed",
    sessionId: SESSION,
    summary: `Prodigi cancel failed for ${PRODIGI_ID} (created)`,
    details: {
      prodigiOrderId: PRODIGI_ID,
      prodigiStage: "created",
      orderStatus: "refunded",
      cancelStatus: 405,
      cancelReason: "prodigi-cancel-http-405",
      cancelMessage: "Prodigi cancel HTTP 405",
    },
    ...overrides,
  };
}

/* --- Port type contract --------------------------------------------------- */

test("OperatorAlert is event-keyed with summary and details", () => {
  const alert = cancelFailedAlert();
  assert.equal(alert.event, "order.prodigi-cancel-failed");
  assert.equal(alert.sessionId, SESSION);
  assert.equal(alert.summary, `Prodigi cancel failed for ${PRODIGI_ID} (created)`);
  assert.equal(alert.details.prodigiOrderId, PRODIGI_ID);
  assert.equal(alert.details.cancelStatus, 405);
  assert.equal(alert.details.cancelReason, "prodigi-cancel-http-405");
});

test("OperatorAlerts.raise is async and resolves void", async () => {
  const calls: OperatorAlert[] = [];
  const alerts: OperatorAlerts = {
    raise: async (alert) => {
      calls.push(alert);
    },
  };
  const result: unknown = await alerts.raise(cancelFailedAlert());
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
});

/* --- buildAlertEmail ------------------------------------------------------ */

test("buildAlertEmail renders event, summary, details and session id", () => {
  const { subject, text } = buildAlertEmail(cancelFailedAlert());
  assert.equal(subject, "Operator alert: order.prodigi-cancel-failed");
  assert.match(text, /order\.prodigi-cancel-failed/);
  assert.match(text, /Prodigi cancel failed/);
  assert.match(text, new RegExp(PRODIGI_ID));
  assert.match(text, /refunded/);
  assert.match(text, /created/);
  assert.match(text, /prodigi-cancel-http-405/);
  assert.match(text, new RegExp(SESSION));
});

test("buildAlertEmail prints null details as (none) and omits a null session", () => {
  const { text } = buildAlertEmail({
    event: "order.unfulfilled",
    sessionId: null,
    summary: "order unfulfilled past SLA",
    details: { reason: null, attempts: 3, lastStatus: null },
  });
  assert.match(text, /\(none\)/);
  assert.equal(text.includes("Session:"), false);
});

/* --- createOperatorAlerts: factory ---------------------------------------- */

test("createOperatorAlerts returns undefined when apiKey is missing", () => {
  assert.equal(
    createOperatorAlerts({ apiKey: "", to: "ops@example.com" }),
    undefined,
  );
  assert.equal(
    createOperatorAlerts({ apiKey: undefined, to: "ops@example.com" }),
    undefined,
  );
});

test("createOperatorAlerts returns undefined when to is missing", () => {
  assert.equal(
    createOperatorAlerts({ apiKey: "re_test_key", to: "" }),
    undefined,
  );
  assert.equal(
    createOperatorAlerts({ apiKey: "re_test_key", to: undefined }),
    undefined,
  );
});

/* --- EmailOperatorAlerts.raise: Resend HTTP ------------------------------- */

test("raise POSTs to the documented Resend URL with auth + payload", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
  };
  const alerts = createOperatorAlerts({
    apiKey: "re_test_key",
    to: "ops@nessebarlens.com",
    fetchImpl,
  });
  assert.ok(alerts);
  const result: unknown = await alerts.raise(cancelFailedAlert());
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.to, ["ops@nessebarlens.com"]);
  assert.match(body.text, new RegExp(PRODIGI_ID));
  assert.match(body.subject, /Operator alert/);
});

test("raise throws on a non-2xx Resend response, carrying the status", async () => {
  const alerts = createOperatorAlerts({
    apiKey: "re_test_key",
    to: "ops@nessebarlens.com",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  assert.ok(alerts);
  await assert.rejects(
    () => alerts.raise(cancelFailedAlert()),
    /Resend HTTP 429/,
  );
});

test("raise throws on a network failure", async () => {
  const alerts = createOperatorAlerts({
    apiKey: "re_test_key",
    to: "ops@nessebarlens.com",
    fetchImpl: async () => {
      throw "socket hang up";
    },
  });
  assert.ok(alerts);
  await assert.rejects(() => alerts.raise(cancelFailedAlert()), /resend-network-error/);
});

test("raise rethrows an Error from fetch as-is (not wrapped as a network error)", async () => {
  const alerts = createOperatorAlerts({
    apiKey: "re_test_key",
    to: "ops@nessebarlens.com",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.ok(alerts);
  await assert.rejects(() => alerts.raise(cancelFailedAlert()), /ECONNREFUSED/);
});

test("raise reports the status with no detail when the body cannot be read", async () => {
  const alerts = createOperatorAlerts({
    apiKey: "re_test_key",
    to: "ops@nessebarlens.com",
    fetchImpl: async () =>
      ({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error("stream broke");
        },
      }) as unknown as Response,
  });
  assert.ok(alerts);
  await assert.rejects(
    () => alerts.raise(cancelFailedAlert()),
    (e: unknown) => e instanceof Error && e.message === "Resend HTTP 502",
  );
});

test("the constructor falls back to the global fetch when none is injected", () => {
  // Exercises the `fetchImpl ?? fetch` default without performing a send.
  const alerts = new EmailOperatorAlerts("re_test_key", "ops@nessebarlens.com");
  assert.ok(alerts instanceof EmailOperatorAlerts);
});

test("raise classifies a timeout via the shared abort idiom", async () => {
  const alerts = new EmailOperatorAlerts(
    "re_test_key",
    "ops@nessebarlens.com",
    async (_url, init) => {
      const signal = init?.signal;
      if (signal) {
        await new Promise<void>((_, reject) => {
          if (signal.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          });
        });
      }
      return new Response("ok");
    },
  );
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    assert.equal(ms, 8_000);
    const ctrl = new AbortController();
    ctrl.abort();
    return ctrl.signal;
  }) as typeof AbortSignal.timeout;
  try {
    await assert.rejects(() => alerts.raise(cancelFailedAlert()), /timed out/);
  } finally {
    AbortSignal.timeout = original;
  }
});

/* --- raiseOperatorAlert dispatch ------------------------------------------ */

test("dispatch logs operator-alert.undelivered when the port is not wired", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  try {
    await raiseOperatorAlert(undefined, cancelFailedAlert());
    assert.ok(lines.some((l) => l.includes("operator-alert.undelivered")));
  } finally {
    console.error = original;
  }
});

test("dispatch logs operator-alert.failed when raise throws an Error", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  const alerts: OperatorAlerts = {
    raise: async () => {
      throw new Error("resend 500");
    },
  };
  try {
    await raiseOperatorAlert(alerts, cancelFailedAlert());
    assert.ok(lines.some((l) => l.includes("operator-alert.failed")));
    assert.ok(lines.some((l) => l.includes("resend 500")));
  } finally {
    console.error = original;
  }
});

test("dispatch logs operator-alert.threw when raise throws a non-Error", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(String(args[0]));
  const alerts: OperatorAlerts = {
    raise: async () => {
      throw "boom";
    },
  };
  try {
    await raiseOperatorAlert(alerts, cancelFailedAlert());
    assert.ok(lines.some((l) => l.includes("operator-alert.threw")));
    assert.ok(lines.some((l) => l.includes("alert-threw")));
  } finally {
    console.error = original;
  }
});

test("dispatch never propagates an alert throw onto the caller", async () => {
  const alerts: OperatorAlerts = {
    raise: async () => {
      throw new Error("nope");
    },
  };
  await raiseOperatorAlert(alerts, cancelFailedAlert());
});
