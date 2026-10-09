import { NextResponse } from "next/server";
import {
  resolvePrintAssetStream,
  verifyPrintAssetRequest,
} from "@/application/fulfillment/print-asset";
import { NO_STORE_HEADERS } from "@/infrastructure/config/private-headers";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Prodigi fetch target: HMAC-gated stream of the catalog master JPEG.
 * Not resolveDownload — no digital-order / session gate.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "";
  const exp = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";

  const bindings = await readWorkerBindings();
  // No `?? printAssetSecret()` fallback: envString already ends in a
  // process.env read, so bindings.printAssetSecret is undefined only when the
  // secret is absent from BOTH sources -- the bare reader would return null
  // there too. tests/print-asset.test.mts holds that equivalence.
  const secret = bindings.printAssetSecret;

  const verified = await verifyPrintAssetRequest(slug, exp, sig, { secret });
  if (!verified.ok) {
    return NextResponse.json(
      { error: verified.error },
      { status: verified.status, headers: NO_STORE_HEADERS },
    );
  }

  const resolved = await resolvePrintAssetStream(verified.slug, bindings.MASTERS);
  if (resolved.kind === "json") {
    return NextResponse.json(resolved.body, {
      status: resolved.status,
      headers: NO_STORE_HEADERS,
    });
  }

  // Stream via binding — never redirect to R2. Force image/jpeg for Prodigi.
  return new NextResponse(resolved.body, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(resolved.size),
      ...NO_STORE_HEADERS,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
