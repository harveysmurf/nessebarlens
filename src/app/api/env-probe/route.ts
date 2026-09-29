import { NextResponse } from "next/server";
import { readCloudflareEnv } from "@/lib/worker-bindings";

export const dynamic = "force-dynamic";
// OpenNext runs this inside the Worker via nodejs_compat.
export const runtime = "nodejs";

/**
 * TEMPORARY. Answers one question: does a synced env_var reach the deployment
 * already serving traffic, or only the next one?
 *
 * Existence check only — it reports whether SYNC_PROBE is set and a truncated
 * form of it, never a credential, and it 404s unless PROBE_ROUTE_ENABLED is
 * truthy. Delete this route in the same PR that settles the answer; leaving an
 * env-reading endpoint on a storefront is not a trade anyone should make for
 * convenience.
 */
export async function GET() {
  const env = await readCloudflareEnv();
  const enabled = ["1", "true", "yes"].includes(
    String(env.PROBE_ROUTE_ENABLED ?? process.env.PROBE_ROUTE_ENABLED ?? "")
      .trim()
      .toLowerCase(),
  );
  if (!enabled) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const raw = env.SYNC_PROBE ?? process.env.SYNC_PROBE;
  const probe = typeof raw === "string" ? raw : undefined;

  // Truncated so a long marker stays comparable without echoing arbitrary
  // caller-controlled content back into a public response.
  return NextResponse.json(
    {
      probePresent: probe !== undefined,
      probeSuffix: probe ? probe.slice(-8) : null,
      probeLength: probe?.length ?? 0,
      requestedAt: new Date().toISOString(),
      // Which env source answered, because if this ever reads process.env the
      // whole probe is meaningless — that is a build-time value, not the
      // synced one.
      source: env.SYNC_PROBE !== undefined ? "worker-env" : "process-env",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
