import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutUrl,
  isNonJsonBody,
  readJsonResponse,
} from "../src/application/checkout/api-payloads.ts";
import { failureCode, failureCopy } from "../src/domain/api/error-code.ts";
import {
  API_ERROR_CODES,
  isApiErrorCode,
  type ApiErrorCode,
} from "../src/domain/ordering/api-error-codes.ts";
import {
  CONTACT_FIELD_ERROR_CODES,
  isContactErrorCode,
  isContactFieldErrorCode,
} from "../src/domain/contact/contact-error-codes.ts";
import {
  isContactField,
  readContactFieldErrors,
} from "../src/domain/contact/contact-message.ts";

/**
 * The failure contract the browser reads.
 *
 * The endpoints answer with a code and nothing else, the copy for a code
 * lives in the dictionary, and the client renders it in the reader's language.
 * These are the three properties that make that work: a code is read from an
 * untrusted body without throwing, a code the page does not know falls back
 * to the generic sentence, and a field error is kept only when the dictionary
 * has a sentence for it.
 */

const COPY: Record<ApiErrorCode, string> = {
  "invalid-request": "We could not read that request. Please try again.",
  "unknown-photo": "That photograph is not available.",
  "option-unavailable": "This print option is not available for this photo.",
  "pricing-unavailable": "Pricing is temporarily unavailable, please try again.",
  "checkout-unavailable":
    "Checkout is temporarily unavailable, please try again.",
  "service-unconfigured":
    "This service is not available at the moment. Please try again later.",
};

const SET = { isCode: isApiErrorCode, copy: COPY };

test("the code is read from an untrusted body without throwing", () => {
  assert.equal(failureCode({ code: "invalid-request" }), "invalid-request");
  // A body that is not an object, a body with no code, and a body whose code
  // is not a string: none of them is a code.
  assert.equal(failureCode(null), null);
  assert.equal(failureCode("invalid-request"), null);
  assert.equal(failureCode({}), null);
  assert.equal(failureCode({ code: 7 }), null);
  assert.equal(failureCode({ code: "" }), null);
});

test("a known code resolves to the page's own words", () => {
  assert.equal(
    failureCopy({ code: "option-unavailable" }, SET, "Checkout failed"),
    "This print option is not available for this photo.",
  );
});

test("a code the page does not know falls back to the generic sentence", () => {
  // A newer deploy answering an older bundle, a body that is not JSON, and a
  // body with no code at all: the customer's next move is the same in every
  // case, so the same sentence serves them all.
  assert.equal(
    failureCopy({ code: "something-new" }, SET, "Checkout failed"),
    "Checkout failed",
  );
  assert.equal(failureCopy(null, SET, "Checkout failed"), "Checkout failed");
  assert.equal(failureCopy({}, SET, "Checkout failed"), "Checkout failed");
  assert.equal(
    failureCopy({ code: "" }, SET, "Checkout failed"),
    "Checkout failed",
  );
});

test("the api codes are a closed set, and the guard says so", () => {
  assert.deepEqual(Object.values(API_ERROR_CODES).sort(), [
    "checkout-unavailable",
    "invalid-request",
    "option-unavailable",
    "pricing-unavailable",
    "service-unconfigured",
    "unknown-photo",
  ]);
  for (const code of Object.values(API_ERROR_CODES)) {
    assert.equal(isApiErrorCode(code), true, code);
  }
  for (const value of ["prodigi-unavailable", "Unknown photoSlug", 7, null, ""]) {
    assert.equal(isApiErrorCode(value), false, String(value));
  }
});

test("the contact codes are the attempt statuses, and the field codes are their own set", () => {
  // The codes a browser reads and the statuses the analytics dataset holds
  // are the same strings: one spelling, and no way for the two to drift.
  assert.equal(isContactErrorCode("malformed"), true);
  assert.equal(isContactErrorCode("unconfigured"), true);
  assert.equal(isContactErrorCode("invalid"), true);
  assert.equal(isContactErrorCode("rate-limited"), true);
  assert.equal(isContactErrorCode("rejected"), true);
  assert.equal(isContactErrorCode("delivery-failed"), true);
  // "ok" is not a failure, so it is not a code.
  assert.equal(isContactErrorCode("ok"), false);
  assert.equal(isContactErrorCode("something-new"), false);
  assert.equal(isContactErrorCode(7), false);

  for (const code of Object.values(CONTACT_FIELD_ERROR_CODES)) {
    assert.equal(isContactFieldErrorCode(code), true, code);
  }
  assert.equal(isContactFieldErrorCode("name-wrong"), false);
  assert.equal(isContactFieldErrorCode(null), false);
});

test("a field error is kept only when the dictionary has words for it", () => {
  const body = {
    fields: [
      { field: "email", code: "email-invalid" },
      { field: "nope", code: "email-invalid" },
      { field: "name", code: "not-a-code" },
      { field: "message", code: "message-too-long" },
      "not-an-object",
    ],
  };
  assert.deepEqual(readContactFieldErrors(body), [
    { field: "email", code: "email-invalid" },
    { field: "message", code: "message-too-long" },
  ]);
  // And a body that carries no fields at all.
  assert.deepEqual(readContactFieldErrors(null), []);
  assert.deepEqual(readContactFieldErrors({}), []);
  assert.deepEqual(readContactFieldErrors({ fields: "nope" }), []);
  assert.deepEqual(readContactFieldErrors({ fields: { field: "name" } }), []);
});

test("the form's fields are a closed set too", () => {
  assert.equal(isContactField("name"), true);
  assert.equal(isContactField("turnstileToken"), true);
  assert.equal(isContactField("token"), false);
  assert.equal(isContactField(7), false);
});

test("a body that is not JSON is a failure to read, and reads as no code", async () => {
  const html = await readJsonResponse(
    new Response("<!DOCTYPE html><html>502</html>", { status: 502 }),
  );
  assert.equal(isNonJsonBody(html), true);
  assert.equal(failureCode(html), null);
  assert.equal(
    failureCopy(html, SET, "Quote failed"),
    "Quote failed",
  );
});

test("a redirect target is refused whatever the failure body says", () => {
  // The code in the body does not make an unsafe url safe: the redirect is
  // resolved by the origin rule, on its own.
  assert.equal(
    checkoutUrl({ url: "http://evil.example/pay", code: "checkout-unavailable" }),
    null,
  );
  assert.equal(
    checkoutUrl({ url: "https://checkout.stripe.com/c/pay/cs_123" }),
    "https://checkout.stripe.com/c/pay/cs_123",
  );
});
