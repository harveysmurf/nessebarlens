/**
 * Analytics Engine writers and /api/e (#119).
 *
 * Two things are pinned here that a route test alone would miss:
 *   1. the exact blob shape of both writers, including that no visitor content
 *      can reach a point; and
 *   2. that analytics failures are invisible — a throwing writeDataPoint must
 *      never turn the beacon or the contact route into an error.
 *
 * /api/e is driven the way Next drives it: a Request in, a Response out, with
 * readWorkerBindings substituted at the module seam.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

import {
  recordContactAttempt,
  recordInteraction,
} from "../src/infrastructure/cloudflare/analytics.ts";
import { TRACK_EVENTS } from "../src/analytics/events.ts";

const FAKE = "buzz-test:analytics-worker-bindings";

type Point = {
  blobs?: unknown[];
  doubles?: number[];
  indexes?: string[];
};

type Fake = {
  analytics?: { writeDataPoint(point?: unknown): void };
  analyticsEnv?: string;
  analyticsRateLimiter?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

const globals = globalThis as {
  __analyticsBindings?: Fake;
  __analyticsPoints?: Point[];
};
globals.__analyticsBindings = {};
globals.__analyticsPoints = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/infrastructure/cloudflare/worker-bindings") {
      return { url: FAKE, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === FAKE) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export async function readWorkerBindings() { return globalThis.__analyticsBindings; }",
      };
    }
    return nextLoad(url, context);
  },
});

const route = await import("../src/app/api/e/route.ts");

function collector(): { analytics: { writeDataPoint(point?: unknown): void }; points: Point[] } {
  const points: Point[] = [];
  return {
    analytics: {
      writeDataPoint: (point) => {
        if (point) points.push(point as Point);
      },
    },
    points,
  };
}

beforeEach(() => {
  globals.__analyticsBindings = {};
  globals.__analyticsPoints = [];
});

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://nessebarlens.com/api/e", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("contact attempts write status and env only, in the documented blob order", () => {
  const { analytics, points } = collector();
  recordContactAttempt(analytics, "staging", "invalid");
  assert.deepEqual(points, [
    {
      blobs: ["contact", "invalid", "staging"],
      doubles: [1],
      indexes: ["contact"],
    },
  ]);
});

test("interactions write event, path and env only", () => {
  const { analytics, points } = collector();
  recordInteraction(analytics, "production", "configurator_open", "/prints/nesebar-1");
  assert.deepEqual(points, [
    {
      blobs: ["configurator_open", "/prints/nesebar-1", "production"],
      doubles: [1],
      indexes: ["configurator_open"],
    },
  ]);
});

test("a missing or throwing dataset is silently skipped", () => {
  assert.doesNotThrow(() => recordContactAttempt(undefined, "production", "ok"));
  const throwing = {
    writeDataPoint() {
      throw new Error("quota");
    },
  };
  assert.doesNotThrow(() => recordContactAttempt(throwing, "production", "ok"));
  assert.doesNotThrow(() =>
    recordInteraction(throwing, "production", "contact_open", "/contact"),
  );
});

test("/api/e accepts each allowlisted event and strips query and hash", async () => {
  const { analytics, points } = collector();
  globals.__analyticsBindings = { analytics, analyticsEnv: "production" };

  for (const event of TRACK_EVENTS) {
    const response = await route.POST(request({ event, path: "/contact?utm=x#form" }));
    assert.equal(response.status, 204);
  }
  assert.deepEqual(
    points.map((p) => p.blobs?.[0]),
    [...TRACK_EVENTS],
  );
  assert.ok(
    points.every((p) => p.blobs?.[1] === "/contact"),
    "query and hash must be stripped before the write",
  );
});

test("/api/e drops an unknown event without writing", async () => {
  const { analytics, points } = collector();
  globals.__analyticsBindings = { analytics, analyticsEnv: "production" };
  const response = await route.POST(request({ event: "checkout_abandoned", path: "/" }));
  assert.equal(response.status, 204);
  assert.equal(points.length, 0);
});

test("/api/e drops an invalid path without writing", async () => {
  const { analytics, points } = collector();
  globals.__analyticsBindings = { analytics, analyticsEnv: "production" };
  for (const path of [123, "contact", "//evil.example", `/${"a".repeat(200)}`]) {
    const response = await route.POST(request({ event: "contact_open", path }));
    assert.equal(response.status, 204);
  }
  assert.equal(points.length, 0);
});

test("/api/e is not an oracle: malformed bodies and limiter rejects are still 204", async () => {
  const { analytics, points } = collector();
  globals.__analyticsBindings = {
    analytics,
    analyticsEnv: "production",
    analyticsRateLimiter: { limit: async () => ({ success: false }) },
  };

  const malformed = await route.POST(
    new Request("https://nessebarlens.com/api/e", { method: "POST", body: "not json" }),
  );
  assert.equal(malformed.status, 204);

  const limited = await route.POST(
    request({ event: "contact_open", path: "/contact" }, { "cf-connecting-ip": "203.0.113.7" }),
  );
  assert.equal(limited.status, 204);
  assert.equal(points.length, 0);
});

test("/api/e ignores a throwing limiter rather than dropping the beacon", async () => {
  const { analytics, points } = collector();
  globals.__analyticsBindings = {
    analytics,
    analyticsEnv: "production",
    analyticsRateLimiter: {
      limit: async () => {
        throw new Error("binding unavailable");
      },
    },
  };
  const response = await route.POST(request({ event: "contact_open", path: "/contact" }));
  assert.equal(response.status, 204);
  assert.equal(points.length, 1);
});
