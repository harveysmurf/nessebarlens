import { NextResponse } from "next/server";
import { readJsonBody } from "@/infrastructure/config/json-body";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";
import { createTurnstileVerifier } from "@/infrastructure/turnstile/cloudflare-turnstile";
import { createContactEmailSender } from "@/infrastructure/contact/email-contact-message";
import { submitContact } from "@/application/contact/submit-contact";
import { contactResponse } from "@/application/contact/contact-response";

/**
 * POST /api/contact (#293).
 *
 * Order of operations, each step refusing before the next and none of them
 * sending mail until the Turnstile token is verified: configuration check →
 * rate limit → validate → Siteverify → send → generic response. The route owns
 * only the wiring; validation, orchestration and the status/body mapping live
 * in pure/port code so they are testable without a Request.
 *
 * Nothing here logs the visitor's name, address or message. A rejection logs a
 * short reason code; a delivery failure logs the Resend diagnostic. Both are
 * safe to keep because neither contains user content.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const bindings = await readWorkerBindings();
  // 503, not a 400: with no verifier or no recipient the feature is not
  // deployed, which is a human's job to fix. Failing closed here means a
  // submission is never accepted on a promise we cannot keep.
  if (
    !bindings.turnstileSecret ||
    !bindings.contactRecipient ||
    !bindings.resendApiKey
  ) {
    console.error(
      "contact unconfigured: TURNSTILE_SECRET_KEY, CONTACT_TO_EMAIL or RESEND_API_KEY is missing",
    );
    return NextResponse.json(
      { error: "Contact is not configured" },
      { status: 503 },
    );
  }

  const remoteIp = request.headers.get("cf-connecting-ip")?.trim() || undefined;
  const outcome = await submitContact(
    body.value,
    { remoteIp, rateLimitKey: remoteIp ?? "unknown" },
    {
      verifyTurnstile: createTurnstileVerifier({
        secretKey: bindings.turnstileSecret,
      }),
      sendEmail: createContactEmailSender({
        apiKey: bindings.resendApiKey,
        to: bindings.contactRecipient,
      }),
      rateLimit: bindings.contactRateLimiter,
    },
  );

  if (outcome.kind === "rejected") {
    console.error("contact.turnstile-rejected", outcome.reason);
  } else if (outcome.kind === "delivery-failed") {
    console.error("contact.delivery-failed", outcome.detail);
  }

  const mapped = contactResponse(outcome);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
