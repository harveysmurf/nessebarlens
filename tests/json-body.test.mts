import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVALID_JSON_ERROR,
  INVALID_JSON_STATUS,
  readJsonBody,
} from "../src/lib/json-body.ts";

/* quote and checkout used to each hand-roll `try { await request.json() } catch`
   and each answer with its own 400 "Invalid JSON". The helper owns that grammar
   now, so these tests pin the helper's own contract: what it returns for a
   parseable body, and the exact status + string it reports for one that is
   not. The route-level half of the contract lives in routes.test.mts, because
   only there can the two handlers be called the way Next calls them. */

const url = "https://nessebarlens.test/api/quote";

const request = (body: BodyInit | null, contentType = "application/json") =>
  new Request(url, { method: "POST", headers: { "content-type": contentType }, body });

test("readJsonBody: the canonical rejection is a 400 and the canonical string", async () => {
  assert.equal(INVALID_JSON_STATUS, 400);
  assert.equal(INVALID_JSON_ERROR, "Invalid JSON");
});

test("readJsonBody: a well-formed body is handed back untouched", async () => {
  for (const payload of [
    { format: "fine-art", size: "30x40" },
    { nested: { a: [1, 2, 3] } },
    [],
    null,
    42,
    "a bare string is valid JSON",
  ]) {
    const parsed = await readJsonBody(request(JSON.stringify(payload)));
    assert.deepEqual(parsed, { ok: true, value: payload }, JSON.stringify(payload));
  }
});

test("readJsonBody: a body that will not parse is a rejection, not a throw", async () => {
  for (const payload of ["not json", "{", '{"format":}', "[1,", "", "undefined"]) {
    const parsed = await readJsonBody(request(payload));
    assert.deepEqual(
      parsed,
      { ok: false, error: INVALID_JSON_ERROR, status: INVALID_JSON_STATUS },
      JSON.stringify(payload),
    );
  }
});

test("readJsonBody: a missing body is a rejection too", async () => {
  const parsed = await readJsonBody(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" } }),
  );
  assert.equal(parsed.ok, false);
});

test("readJsonBody: no content-type is not a reason to reject", async () => {
  const parsed = await readJsonBody(request('{"format":"fine-art"}', "text/plain"));
  assert.deepEqual(parsed, { ok: true, value: { format: "fine-art" } });
});
