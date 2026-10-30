/**
 * Plain-text customer email copy (#117).
 *
 * Imitates print-copy.ts: the words live here, keyed off EmailKind, so a new
 * kind is a compile error until someone writes the subject and body. Plain
 * text only — no HTML, and never a master key, an asset URL, or a Prodigi id.
 * Those are internal; a customer who sees them would only be confused or
 * exposed to a credential that is not theirs to hold.
 *
 * The digital confirmation links the success page (`siteUrl` + session path),
 * not a download token minted in this request. Minting a token inside an email
 * builder would couple copy to the store and would let a re-send mint a second
 * credential; the success page already knows how to hand over the link.
 *
 * **The copy is per locale, and the locale is a fact about the order.** It is
 * not read from the customer, not inferred from the address, and not the
 * deployment's default: a print that ships weeks later has to be announced in
 * the language the customer ordered in, and the only thing that remembers that
 * is the order record. So `locale` is a required field — a caller that has not
 * decided which language the mail is in cannot build the mail.
 *
 * What is *not* translated: the carrier's name, the tracking number, the
 * tracking URL, the order reference, and the studio's signature. Those are
 * values, not words, and a carrier does not have a Bulgarian name.
 */

import { EMAIL_KINDS, type EmailKind } from "./email";
import { orderReference } from "./order-reference";
import { SESSION_ID_PARAM } from "./order-decision";
import { localePath } from "../i18n/locale-path";
import type { Locale } from "../i18n/locale";

export type EmailCopyInput = {
  kind: EmailKind;
  sessionId: string;
  /** Absolute origin, no trailing slash — same contract as siteUrl(). */
  siteUrl: string;
  /** The language of the order this mail is about. */
  locale: Locale;
  /** Tracking number for print-shipped; ignored by other kinds. */
  trackingNumber?: string | undefined;
  /** Carrier name for print-shipped; ignored by other kinds. */
  carrier?: string | undefined;
  /** Tracking URL for print-shipped; ignored by other kinds. */
  trackingUrl?: string | undefined;
};

export type EmailCopy = {
  subject: string;
  text: string;
};

/**
 * The signature every email from the studio closes with.
 *
 * It was written out four times — once in each of the three customer emails and
 * once in the operator alert — so a rebrand was a four-place edit, and the first
 * edit to miss one would have signed half the studio's mail differently. Owned
 * here rather than in the alerts adapter because this is where the studio's
 * wording lives; `email-operator-alerts.ts` already imports the Resend constants
 * from its sibling in `domain/ordering/`.
 */
export const STUDIO_SIGNATURE = "— Nessebar Lens";

/**
 * The label in front of the order reference, per locale.
 *
 * The colon is part of the label, so the line reads the same in every language
 * and the label and its punctuation cannot be separated by a caller.
 */
const REFERENCE_LABEL: Record<Locale, string> = {
  en: "Reference:",
  bg: "Референция:",
};

/**
 * The line that tells a customer which order the mail is about.
 *
 * `orderReference` is the derivation, and it is already shared with the success
 * page; what was local to this module was the label in front of it, which is
 * now one word per locale instead of three spellings in three shapes.
 */
export function referenceLine(sessionId: string, locale: Locale): string {
  return `${REFERENCE_LABEL[locale]} ${orderReference(sessionId)}`;
}

/**
 * The values a body interpolates.
 *
 * Flat on purpose: each body function reads the ones it needs, and the ones it
 * does not read are empty rather than absent, so no template has to guard.
 */
type BodyValues = {
  /** The order reference line, label included. */
  reference: string;
  /** The success page URL, in the order's language. */
  successUrl: string;
  /** The carrier's name, untranslated — a carrier has one name. */
  carrier: string;
  /** The tracking number, untranslated — it is a number. */
  trackingNumber: string;
  /** The tracking URL, untranslated — it is a URL. */
  trackingUrl: string;
};

/**
 * The subject and the body of each kind, per locale.
 *
 * The bodies are functions because they interpolate: the confirmation carries
 * the success URL, and the shipped mail carries the carrier's details. The
 * subject is a plain string, because no subject interpolates anything.
 *
 * The kinds are the computed keys of `EMAIL_KINDS`, not the literals: the kind
 * vocabulary has one owner, `email.ts`, and a copy layer that spelled the
 * literals would be a second owner of a vocabulary a rename could reach one
 * half of.
 */
type Templates = {
  subjects: Record<EmailKind, string>;
  bodies: Record<EmailKind, (values: BodyValues) => string[]>;
};

const TEMPLATES: Record<Locale, Templates> = {
  en: {
    subjects: {
      [EMAIL_KINDS.orderConfirmation]: "Your Nessebar Lens order",
      [EMAIL_KINDS.printShipped]: "Your Nessebar Lens print has shipped",
      [EMAIL_KINDS.orderUnfulfilled]: "We could not complete your Nessebar Lens order",
    },
    bodies: {
      [EMAIL_KINDS.orderConfirmation]: (v) => [
        "Thank you for your order.",
        "",
        "You can check its status here:",
        v.successUrl,
        "",
        "If you bought a digital copy, the download link is on that page once it is ready.",
        "If you bought a print, we will email you again when it ships.",
        "",
        v.reference,
        "",
        STUDIO_SIGNATURE,
      ],
      [EMAIL_KINDS.printShipped]: (v) => {
        const lines = ["Your print has shipped.", ""];
        if (v.carrier) lines.push(`Carrier: ${v.carrier}`);
        if (v.trackingNumber) lines.push(`Tracking number: ${v.trackingNumber}`);
        if (v.trackingUrl) lines.push(`Tracking: ${v.trackingUrl}`);
        if (!v.carrier && !v.trackingNumber && !v.trackingUrl) {
          lines.push("Your carrier will provide tracking details separately.");
        }
        lines.push("", v.reference, "", STUDIO_SIGNATURE);
        return lines;
      },
      [EMAIL_KINDS.orderUnfulfilled]: (v) => [
        "We received your payment, but we could not complete your order automatically, so it has not gone into production yet. We will contact you by email about it.",
        "",
        v.reference,
        "",
        "Please reply to this email (or contact us via the site) and we will make it right — a refund or a fresh attempt, whichever you prefer.",
        "",
        STUDIO_SIGNATURE,
      ],
    },
  },
  bg: {
    subjects: {
      [EMAIL_KINDS.orderConfirmation]: "Вашата поръчка за Nessebar Lens",
      [EMAIL_KINDS.printShipped]: "Вашият печат от Nessebar Lens е изпратен",
      [EMAIL_KINDS.orderUnfulfilled]: "Не можем да завършим поръчката ви за Nessebar Lens",
    },
    bodies: {
      [EMAIL_KINDS.orderConfirmation]: (v) => [
        "Благодарим ви за поръчката.",
        "",
        "Можете да проверите статуса ѝ тук:",
        v.successUrl,
        "",
        "Ако сте поръчали цифров файл, връзката за изтегляне ще бъде на тази страница, когато е готова.",
        "Ако сте поръчали печат, ще ви изпратим имейл, когато бъде изпратен.",
        "",
        v.reference,
        "",
        STUDIO_SIGNATURE,
      ],
      [EMAIL_KINDS.printShipped]: (v) => {
        const lines = ["Печатът ви е изпратен.", ""];
        if (v.carrier) lines.push(`Куриер: ${v.carrier}`);
        if (v.trackingNumber) {
          lines.push(`Номер за проследяване: ${v.trackingNumber}`);
        }
        if (v.trackingUrl) lines.push(`Проследяване: ${v.trackingUrl}`);
        if (!v.carrier && !v.trackingNumber && !v.trackingUrl) {
          lines.push(
            "Куриерът ще ви изпрати данните за проследяване отделно.",
          );
        }
        lines.push("", v.reference, "", STUDIO_SIGNATURE);
        return lines;
      },
      [EMAIL_KINDS.orderUnfulfilled]: (v) => [
        "Получихме плащането ви, но не можем да завършим поръчката автоматично, така че тя още не е в производство. Ще се свържем с вас по имейл за нея.",
        "",
        v.reference,
        "",
        "Моля, отговорете на този имейл (или се свържете с нас през сайта) и ще поправим ситуацията — възстановяване на средствата или нов опит, кактото предпочетете.",
        "",
        STUDIO_SIGNATURE,
      ],
    },
  },
};

/**
 * Build the subject and body for one kind. Pure: no I/O, no env reads.
 * Callers pass `siteUrl` in so this module stays free of config.ts.
 */
export function emailCopyFor(input: EmailCopyInput): EmailCopy {
  const templates = TEMPLATES[input.locale];
  // The success page, not a token URL: the page is the one place that
  // resolves "is this digital-ready / physical / revoked" for a session the
  // customer already paid for. Its path carries the order's locale, so the
  // customer lands on the page in the language they ordered in.
  const successUrl = `${input.siteUrl}${localePath(
    input.locale,
    `/checkout/success?${SESSION_ID_PARAM}=${input.sessionId}`,
  )}`;
  const values: BodyValues = {
    reference: referenceLine(input.sessionId, input.locale),
    successUrl,
    carrier: (input.carrier ?? "").trim(),
    trackingNumber: (input.trackingNumber ?? "").trim(),
    trackingUrl: (input.trackingUrl ?? "").trim(),
  };
  return {
    subject: templates.subjects[input.kind],
    text: templates.bodies[input.kind](values).join("\n"),
  };
}
