"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseContactMessage,
  readContactFieldErrors,
  type ContactField,
  type ContactMessage,
} from "@/domain/contact/contact-message";
import {
  isContactErrorCode,
  type ContactFieldErrorCode,
} from "@/domain/contact/contact-error-codes";
import { failureCopy } from "@/domain/api/error-code";
import { postJson } from "@/infrastructure/http/post-json";
import { readJsonResponse } from "@/application/checkout/api-payloads";
import { track } from "@/analytics/track";
import { TURNSTILE_LANGUAGES, type Locale } from "@/domain/i18n/locale";
import type { ContactCopy } from "@/components/i18n/dictionaries";
import {
  fieldControlClass,
  fieldErrorClass,
  fieldLabelClass,
} from "./field-styles";
import { Button } from "@/components/Button";

/**
 * Contact form (#293).
 *
 * A client component because it owns field state, the Turnstile widget and the
 * submit round-trip. Validation is *not* re-implemented here: it calls the same
 * pure `parseContactMessage` the server uses, so the two cannot drift and the
 * email rule stays single-sourced. The server still re-validates — the client
 * copy is UX, not a trust boundary.
 *
 * Everything the visitor reads comes from the dictionary, handed over by the
 * server page as a prop: the labels, the field errors, the messages under the
 * form. Nothing here is written in one language, and nothing here is a
 * sentence the server sent — the server sends codes, and the copy for a code
 * is rendered here, in the page's language.
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
      /** The language the challenge is shown in. */
      language: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

/** The rejection of each field, as the code the dictionary holds words for. */
type FieldErrors = Partial<Record<ContactField, ContactFieldErrorCode>>;

/**
 * The widget API the Turnstile script puts on `window`, or undefined until the
 * script has loaded.
 *
 * One reader rather than an assertion at each of the three use sites. The
 * assertion is a narrowing onto an intersection, which needs no `unknown` step,
 * so it checks: a `Window` cannot be a `Window & { turnstile }` by accident. It
 * stays local to this component rather than augmenting the global `Window`
 * interface, which would let any other module read `window.turnstile` believing
 * the widget is there.
 */
function turnstileApi(): TurnstileApi | undefined {
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

/**
 * Run the domain's validation over the current values, keyed by field for
 * inline rendering. The token is included so a missing challenge is reported
 * with the other problems rather than as a separate round-trip.
 */
function fieldErrors(values: ContactMessage): FieldErrors {
  const parsed = parseContactMessage(values);
  if (parsed.ok) return {};
  const errors: FieldErrors = {};
  for (const error of parsed.errors) errors[error.field] = error.code;
  return errors;
}

export function ContactForm({
  siteKey,
  locale,
  copy,
}: {
  siteKey?: string | undefined;
  /** The locale of the page: the widget speaks it, and the copy is in it. */
  locale: Locale;
  /** The contact form's own words, in the page's language. */
  copy: ContactCopy;
}) {
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
    const turnstile = turnstileApi();
    if (!siteKey || !turnstile || !widgetContainer.current || widgetId.current) return;
    widgetId.current = turnstile.render(widgetContainer.current, {
      sitekey: siteKey,
      // The challenge is shown in the page's language: a Bulgarian reader is
      // asked to pass an English check otherwise.
      language: TURNSTILE_LANGUAGES[locale],
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
  }, [siteKey, locale]);

  useEffect(() => {
    if (scriptReady) renderWidget();
  }, [scriptReady, renderWidget]);

  useEffect(() => {
    track("contact_open");
  }, []);

  useEffect(() => {
    return () => {
      const turnstile = turnstileApi();
      if (widgetId.current && turnstile) {
        turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, []);

  function resetWidget() {
    token.current = "";
    const turnstile = turnstileApi();
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
      const res = await postJson("/api/contact", {
        name: name.trim(),
        email: email.trim(),
        message: message.trim(),
        turnstileToken: token.current,
      });
      // Read the body the way the configurator reads it: a response that is
      // not JSON is a failure to read, not a failure to parse, and the copy
      // below is what the visitor sees either way. The body carries a code,
      // and the copy for the code is this page's.
      const data: unknown = await readJsonResponse(res);
      if (!res.ok) {
        // The server's field rejections are the authority on what was wrong
        // with the message, so they replace the local ones.
        const reported = readContactFieldErrors(data);
        if (reported.length > 0) {
          const mapped: FieldErrors = {};
          for (const error of reported) mapped[error.field] = error.code;
          setErrors(mapped);
        }
        setFormError(
          failureCopy(
            data,
            { isCode: isContactErrorCode, copy: copy.errors },
            copy.failed,
          ),
        );
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
      setFormError(copy.failed);
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
          {copy.unavailable}
        </p>
      )}

      <div>
        <label htmlFor="contact-name" className={fieldLabelClass()}>
          {copy.labels.name}
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
          className={fieldControlClass()}
        />
        {errors.name && (
          <p id="contact-name-error" role="alert" className={fieldErrorClass()}>
            {copy.fieldErrors[errors.name]}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="contact-email" className={fieldLabelClass()}>
          {copy.labels.email}
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
          className={fieldControlClass()}
        />
        {errors.email && (
          <p id="contact-email-error" role="alert" className={fieldErrorClass()}>
            {copy.fieldErrors[errors.email]}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="contact-message" className={fieldLabelClass()}>
          {copy.labels.message}
        </label>
        <textarea
          id="contact-message"
          name="message"
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? "contact-message-error" : undefined}
          className={fieldControlClass()}
        />
        {errors.message && (
          <p id="contact-message-error" role="alert" className={fieldErrorClass()}>
            {copy.fieldErrors[errors.message]}
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
          <p role="alert" className={fieldErrorClass()}>
            {copy.fieldErrors[errors.turnstileToken]}
          </p>
        )}
      </div>

      {sent && (
        <p className="text-xs text-stone-700 bg-gallery-100 border border-gallery-200 rounded p-3" role="status">
          {copy.sent}
        </p>
      )}
      {formError && (
        <p role="alert" className="text-[11px] text-red-700">
          {formError}
        </p>
      )}

      <Button type="submit" shape="form" disabled={disabled}>
        {busy ? copy.sending : copy.send}
      </Button>
    </form>
  );
}
