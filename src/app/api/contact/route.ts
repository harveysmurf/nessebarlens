import { NextResponse } from "next/server";
import { readJsonBody } from "@/infrastructure/config/json-body";
import { CONTACT_ATTEMPT_STATUSES } from "@/domain/contact/contact-status";
import { readWorkerBindings } from "@/infrastructure/cloudflare/worker-bindings";
import { createTurnstileVerifier } from "@/infrastructure/turnstile/cloudflare-turnstile";
import { createContactEmailSender } from "@/infrastructure/contact/email-contact-message";
import { submitContact } from "@/application/contact/submit-contact";
import { contactResponse } from "@/application/contact/contact-response";
import { recordContactAttempt } from "@/infrastructure/cloudflare/analytics";

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
  const bindings = await readWorkerBindings();
  const body = await readJsonBody(request);
  if (!body.ok) {
    // The reason goes to the log; the browser gets the code, and the copy for
    // the code is the reader's language.
    console.error("contact.malformed-body", body.error);
    const response = NextResponse.json(
      { code: CONTACT_ATTEMPT_STATUSES.malformed },
      { status: body.status },
    );
    recordContactAttempt(
      bindings.analytics,
      bindings.analyticsEnv,
      CONTACT_ATTEMPT_STATUSES.malformed,
    );
    return response;
  }

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
    const response = NextResponse.json(
      { code: CONTACT_ATTEMPT_STATUSES.unconfigured },
      { status: 503 },
    );
    recordContactAttempt(
      bindings.analytics,
      bindings.analyticsEnv,
      CONTACT_ATTEMPT_STATUSES.unconfigured,
    );
    return response;
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

  if (outcome.kind === CONTACT_ATTEMPT_STATUSES.rejected) {
    console.error("contact.turnstile-rejected", outcome.reason);
  } else if (outcome.kind === CONTACT_ATTEMPT_STATUSES.deliveryFailed) {
    console.error("contact.delivery-failed", outcome.detail);
  }

  const mapped = contactResponse(outcome);
  // Status only: the closed ContactOutcome kind, never name, email, message,
  // IP or user agent.
  recordContactAttempt(bindings.analytics, bindings.analyticsEnv, outcome.kind);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
