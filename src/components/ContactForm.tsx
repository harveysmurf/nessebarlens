"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseContactMessage } from "@/domain/contact/contact-message";

/**
 * Contact form (#293).
 *
 * A client component because it owns field state, the Turnstile widget and the
 * submit round-trip. Validation is *not* re-implemented here: it calls the same
 * pure `parseContactMessage` the server uses, so the two cannot drift and the
 * email rule stays single-sourced. The server still re-validates — the client
 * copy is UX, not a trust boundary.
 *
 * Turnstile is rendered explicitly so React owns its lifecycle: the script is
 * loaded once, the widget is rendered into a ref'd div, and it is reset after
 * every failed submit because a token is single-use. When no site key is
 * configured the widget and the submit button are disabled with a visible
 * explanation, rather than showing a challenge that can never pass.
 */

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

type ContactFieldName = "name" | "email" | "message" | "turnstileToken";
type FieldErrors = Partial<Record<ContactFieldName, string>>;

const INPUT_CLASS =
  "w-full border border-stone-300 rounded p-2.5 text-sm bg-stone-50 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";
const LABEL_CLASS =
  "block font-semibold uppercase tracking-wider text-[10px] text-stone-600 mb-1.5";

/**
 * Run the domain's validation over the current values, keyed by field for
 * inline rendering. The token is included so a missing challenge is reported
 * with the other problems rather than as a separate round-trip.
 */
function fieldErrors(values: {
  name: string;
  email: string;
  message: string;
  turnstileToken: string;
}): FieldErrors {
  const parsed = parseContactMessage(values);
  if (parsed.ok) return {};
  const errors: FieldErrors = {};
  for (const error of parsed.errors) errors[error.field] = error.message;
  return errors;
}

export function ContactForm({ siteKey }: { siteKey?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);

  const widgetContainer = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef("");

  const renderWidget = useCallback(() => {
    const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (!siteKey || !turnstile || !widgetContainer.current || widgetId.current) return;
    widgetId.current = turnstile.render(widgetContainer.current, {
      sitekey: siteKey,
      callback: (value) => {
        token.current = value;
      },
      "expired-callback": () => {
        token.current = "";
      },
      "error-callback": () => {
        token.current = "";
      },
    });
  }, [siteKey]);

  useEffect(() => {
    if (scriptReady) renderWidget();
  }, [scriptReady, renderWidget]);

  useEffect(() => {
    return () => {
      const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (widgetId.current && turnstile) {
        turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, []);

  function resetWidget() {
    token.current = "";
    const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    if (widgetId.current && turnstile) turnstile.reset(widgetId.current);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSent(false);

    const found = fieldErrors({
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
      turnstileToken: token.current,
    });
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});

    setBusy(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          message: message.trim(),
          turnstileToken: token.current,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const copy =
          data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : "Sorry, your message could not be sent. Please try again.";
        setFormError(copy);
        // The token is spent (or the submit never verified): ask for a new one.
        resetWidget();
        return;
      }
      setSent(true);
      setName("");
      setEmail("");
      setMessage("");
      resetWidget();
    } catch {
      setFormError("Sorry, your message could not be sent. Please try again.");
      resetWidget();
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !siteKey;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {!siteKey && (
        <p
          className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3"
          role="status"
        >
          The contact form is temporarily unavailable. Please try again later.
        </p>
      )}

      <div>
        <label htmlFor="contact-name" className={LABEL_CLASS}>
          Name
        </label>
        <input
          id="contact-name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "contact-name-error" : undefined}
          className={INPUT_CLASS}
        />
        {errors.name && (
          <p id="contact-name-error" role="alert" className="text-[11px] text-red-700 mt-1.5">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="contact-email" className={LABEL_CLASS}>
          Email
        </label>
        <input
          id="contact-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? "contact-email-error" : undefined}
          className={INPUT_CLASS}
        />
        {errors.email && (
          <p id="contact-email-error" role="alert" className="text-[11px] text-red-700 mt-1.5">
            {errors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="contact-message" className={LABEL_CLASS}>
          Message
        </label>
        <textarea
          id="contact-message"
          name="message"
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? "contact-message-error" : undefined}
          className={INPUT_CLASS}
        />
        {errors.message && (
          <p id="contact-message-error" role="alert" className="text-[11px] text-red-700 mt-1.5">
            {errors.message}
          </p>
        )}
      </div>

      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
      />

      <div>
        <div ref={widgetContainer} data-testid="turnstile-widget" />
        {errors.turnstileToken && (
          <p role="alert" className="text-[11px] text-red-700 mt-1.5">
            {errors.turnstileToken}
          </p>
        )}
      </div>

      {sent && (
        <p className="text-xs text-stone-700 bg-gallery-100 border border-gallery-200 rounded p-3" role="status">
          Thank you — your message has been sent. I&apos;ll be in touch soon.
        </p>
      )}
      {formError && (
        <p role="alert" className="text-[11px] text-red-700">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="w-full bg-stone-900 hover:bg-stone-800 disabled:opacity-60 text-white font-medium py-3.5 px-4 rounded text-xs uppercase tracking-widest transition-all shadow-sm"
      >
        {busy ? "Sending…" : "Send Message"}
      </button>
    </form>
  );
}
