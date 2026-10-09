import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  readMasterObject,
  type MasterObject,
  type MastersBucket,
} from "../src/domain/catalog/master-key.ts";

const root = path.join(import.meta.dirname, "..");

function bucket(
  behaviour: (key: string) => Promise<MasterObject | null>,
): MastersBucket {
  return { get: behaviour };
}

function object(size = 7): MasterObject {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    }),
    size,
  };
}

test("a missing bucket and a throwing get() are the same 503", async () => {
  assert.deepEqual(await readMasterObject("prints/dawn.jpg", undefined), {
    ok: false,
    status: 503,
    error: "masters-unavailable",
  });
  assert.deepEqual(
    await readMasterObject(
      "prints/dawn.jpg",
      bucket(async () => {
        throw new Error("r2 down");
      }),
    ),
    { ok: false, status: 503, error: "masters-unavailable" },
  );
});

test("a null object is a 404, not a 503", async () => {
  assert.deepEqual(await readMasterObject("prints/dawn.jpg", bucket(async () => null)), {
    ok: false,
    status: 404,
    error: "master-not-found",
  });
});

test("a hit returns the object untouched, so callers keep their own envelope", async () => {
  const found = object(11);
  const read = await readMasterObject(
    "prints/dawn.jpg",
    bucket(async (key) => (key === "prints/dawn.jpg" ? found : null)),
  );
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.object.size, 11);
  assert.equal(read.ok && read.object.httpMetadata, undefined);
});

test("MasterObject is derived from R2ObjectBody, not re-spelled by hand", () => {
  // #109 was a type that lied: `contentType` is not a field R2ObjectBody has,
  // so `object.contentType` compiled, was always undefined, and every master
  // was served as image/jpeg. A behavioural test cannot catch that class of
  // bug — the fake and the code can agree on a field the platform does not
  // have. This source check is what catches it: the shape is required to name
  // its fields off R2ObjectBody, and no reader is allowed to ask an R2 object
  // for a top-level `contentType` again. (tsconfig excludes tests/, so a
  // @ts-expect-error here would never be checked — the source is the guard.)
  const masterKey = fs.readFileSync(
    path.join(root, "src/domain/catalog/master-key.ts"),
    "utf8",
  );
  assert.match(
    masterKey,
    /import type \{[^}]*R2ObjectBody[^}]*\} from "@cloudflare\/workers-types"/,
    "MasterObject must be derived from the platform's R2ObjectBody",
  );
  assert.match(masterKey, /size: R2ObjectBody\["size"\]/);
  assert.match(masterKey, /httpMetadata: R2ObjectBody\["httpMetadata"\]/);
  assert.doesNotMatch(
    masterKey,
    /contentType\??:/,
    "a hand-declared contentType field is the #109 bug in waiting",
  );

  // And the one place that used it now reads the real path.
  const download = fs.readFileSync(
    path.join(root, "src/domain/ordering/order-decision.ts"),
    "utf8",
  );
  assert.match(
    download,
    /contentType: object\.httpMetadata\?\.contentType \|\| "image\/jpeg"/,
  );
  assert.doesNotMatch(download, /object\.contentType\b/);
});
