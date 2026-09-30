import assert from "node:assert/strict";
import test from "node:test";
import {
  readMasterObject,
  type MasterObject,
  type MastersBucket,
} from "../src/lib/master-key.ts";

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
  assert.equal(read.ok && read.object.contentType, undefined);
});
