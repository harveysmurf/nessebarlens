/**
 * The locale of a checkout, from the body to the email.
 *
 * Slice 4 of 5 of the localisation epic. The rule the whole slice rests on is
 * one sentence: **the language of an order is a fact about the order**, stored
 * with it, and not something re-guessed at each step.
 *
 * The steps that used to guess are the ones this file pins:
 *
 *   - the body says which language the buyer is reading in, because the server
 *     cannot know it;
 *   - the order record carries it, because a print that ships weeks later must
 *     be announced in the language the customer ordered in, and neither the
 *     customer's address nor the deployment's default says which that was;
 *   - the email reads it from the record, because the email may be triggered
 *     long after the customer left the page.
 *
 * Three of the assertions here are about what must *not* happen, and they are
 * the ones that would cost money if they broke: an invalid locale is refused
 * before any provider is called, a legacy record is read rather than
 * rejected, and the idempotency key does not change with the language.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseCheckoutBody } from "../src/domain/ordering/checkout-body.ts";
import {
  decideFulfillment,
  parseOrderRecord,
} from "../src/domain/ordering/order-decision.ts";
import {
  emailCopyFor,
  referenceLine,
} from "../src/domain/ordering/email-copy.ts";
import {
  digitalDescription,
  fillDownloadSentence,
  physicalDescription,
  shippingDisplayName,
  ttlPhrase,
} from "../src/domain/ordering/checkout-copy.ts";
import {
  pluralCategory,
  pluralUnit,
} from "../src/domain/i18n/plurals.ts";
import { localeOrDefault } from "../src/domain/i18n/locale.ts";
import { getDictionary } from "../src/components/i18n/dictionaries.ts";

const SLUG = "saint-spiridov";
const SESSION = "cs_test_abcdefgh";

/** A paid digital session, in the language the buyer ordered in. */
function paidSession(metadata: Record<string, string>) {
  return {
    sessionId: SESSION,
    paymentStatus: "paid",
    currency: "eur",
    amountTotal: 1500,
    metadata: {
      format: "digital",
      quoteEur: "15",
      photoSlug: SLUG,
      ...metadata,
    },
    shippingDetails: null,
    customerEmail: "buyer@example.test",
    customerPhone: null,
    prodigiKeyConfigured: true,
    now: "2026-10-28T10:00:00.000Z",
  };
}

test("the body carries the locale, and a missing one is English", () => {
  // A body from a client that predates the locale segment must still buy a
  // print: refusing it would take the site down for every client that has not
  // been updated.
  const parsed = parseCheckoutBody({ photoSlug: SLUG, format: "digital" });
  assert.ok(!("error" in parsed), "a body without a locale is accepted");
  assert.equal(parsed.locale, "en");
});

test("the body carries the locale it was given", () => {
  const parsed = parseCheckoutBody({
    photoSlug: SLUG,
    format: "digital",
    locale: "bg",
  });
  assert.ok(!("error" in parsed));
  assert.equal(parsed.locale, "bg");
});

test("a locale the site does not serve is refused", () => {
  // Refused, not defaulted: the client said which language it is and we do not
  // have that language, and continuing would produce a receipt, a return page
  // and an email in a language nobody asked for.
  for (const locale of ["de", "EN", "en-GB", "", " english", 42, null, true]) {
    const parsed = parseCheckoutBody({
      photoSlug: SLUG,
      format: "digital",
      locale,
    });
    assert.ok(
      "error" in parsed,
      `${JSON.stringify(locale)} must be refused, not accepted`,
    );
    assert.match(parsed.error, /locale/);
  }
});

test("the order record stores the locale the session was created in", () => {
  const decided = decideFulfillment(paidSession({ locale: "bg" }));
  assert.equal(decided.action, "write");
  assert.ok(decided.action === "write");
  assert.equal(decided.record.locale, "bg");
});

test("a session created before the locale existed is stored as English", () => {
  const decided = decideFulfillment(paidSession({}));
  assert.ok(decided.action === "write");
  assert.equal(decided.record.locale, "en");
});

test("a record without a locale still parses, and reads as English", () => {
  // The record predates the field. Rejecting it would turn a paid order into
  // "corrupt" over a field that decides nothing but the language of an email.
  const legacy = JSON.stringify({
    v: 1,
    sessionId: SESSION,
    merchantReference: SESSION,
    terminal: true,
    status: "paid-unfulfilled",
    photoSlug: SLUG,
    format: "digital",
    size: "",
    frame: "",
    quoteEur: 15,
    amountTotal: 1500,
    currency: "eur",
    reason: "bad-metadata",
    masterKey: null,
    recipient: null,
    prodigiOrderId: null,
    prodigiStage: null,
    assetUrl: null,
    updatedAt: "2026-10-28T10:00:00.000Z",
  });
  const parsed = parseOrderRecord(legacy);
  assert.ok(parsed, "a record without a locale must not be rejected");
  assert.equal(parsed.locale, "en");
});

test("a record with an unknown locale reads as English rather than being rejected", () => {
  // A value written by a version we do not know, or by a hand-edited record.
  // Either way the order is paid and the money is ours; the field decides the
  // language of an email, and English is the honest answer for both.
  const decided = decideFulfillment(paidSession({ locale: "de" }));
  assert.ok(decided.action === "write");
  const parsed = parseOrderRecord(JSON.stringify(decided.record));
  assert.ok(parsed, "an unknown locale must not reject the record");
  assert.equal(parsed.locale, "en");
});

test("the stored locale decides the language of the order", () => {
  assert.equal(localeOrDefault("bg"), "bg");
  assert.equal(localeOrDefault("en"), "en");
  assert.equal(localeOrDefault("de"), "en");
  assert.equal(localeOrDefault(undefined), "en");
  assert.equal(localeOrDefault(42), "en");
});

test("the confirmation email is in the order's language, and links to its success page", () => {
  const copy = emailCopyFor({
    kind: "order-confirmation",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    locale: "bg",
  });
  assert.equal(copy.subject, "Вашата поръчка за Nessebar Lens");
  assert.match(copy.text, /Благодарим ви за поръчката\./);
  // The link is the success page in the order's language, not the English one.
  assert.match(
    copy.text,
    /https:\/\/nessebarlens\.com\/bg\/checkout\/success\?session_id=cs_test_abcdefgh/,
  );
  assert.equal(copy.text.includes("/en/"), false, "the link names one language");
  // And it is still the success page, not a token or an internal id.
  assert.equal(copy.text.includes("prints/"), false);
  assert.equal(copy.text.includes("token="), false);
  assert.equal(copy.text.includes("ord_"), false);
});

test("an English order links to the English success page", () => {
  const copy = emailCopyFor({
    kind: "order-confirmation",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    locale: "en",
  });
  assert.equal(copy.subject, "Your Nessebar Lens order");
  assert.match(
    copy.text,
    /https:\/\/nessebarlens\.com\/en\/checkout\/success\?session_id=cs_test_abcdefgh/,
  );
});

test("the shipped email is in the order's language, and the carrier's details are not translated", () => {
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    locale: "bg",
    carrier: "DHL",
    trackingNumber: "1Z999",
    trackingUrl: "https://track.example/1Z999",
  });
  assert.equal(copy.subject, "Вашият печат от Nessebar Lens е изпратен");
  assert.match(copy.text, /Куриер: DHL/);
  assert.match(copy.text, /Номер за проследяване: 1Z999/);
  assert.match(copy.text, /Проследяване: https:\/\/track\.example\/1Z999/);
  // A carrier has one name, a tracking number is a number and a tracking URL is
  // a URL: none of them is ours to translate.
  assert.equal(copy.text.includes("Carrier:"), false);
  assert.equal(copy.text.includes("Tracking number:"), false);
});

test("a shipped email with no tracking details says so in the order's language", () => {
  // The third shape of the shipped email, in Bulgarian: Prodigi can mark a
  // shipment shipped before a carrier posts tracking, and an empty labelled
  // line reads as a bug.
  const copy = emailCopyFor({
    kind: "print-shipped",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    locale: "bg",
    carrier: "",
    trackingNumber: "   ",
    trackingUrl: undefined,
  });
  assert.match(copy.text, /Куриерът ще ви изпрати данните за проследяване отделно\./);
  assert.equal(copy.text.includes("Куриер: "), false);
  assert.equal(copy.text.includes("Номер за проследяване:"), false);
});

test("the unfulfilled email is in the order's language", () => {
  const copy = emailCopyFor({
    kind: "order-unfulfilled",
    sessionId: SESSION,
    siteUrl: "https://nessebarlens.com",
    locale: "bg",
  });
  assert.equal(copy.subject, "Не можем да завършим поръчката ви за Nessebar Lens");
  assert.match(copy.text, /Получихме плащането ви/);
  // It must not say the print is being made: it was not.
  assert.doesNotMatch(copy.text, /being produced/i);
});

test("the reference line is labelled in the order's language", () => {
  assert.equal(referenceLine(SESSION, "en"), "Reference: ABCDEFGH");
  assert.equal(referenceLine(SESSION, "bg"), "Номер на поръчката: ABCDEFGH");
});

test("the plural rules are the language's, not an appended s", () => {
  // English: one and other.
  assert.equal(pluralCategory(1, "en"), "one");
  assert.equal(pluralCategory(2, "en"), "other");
  assert.equal(pluralCategory(0, "en"), "other");
  // Bulgarian: one for the single case and other for everything else — and the
  // words differ, "1 ден" but "2 дни". The rules come from the language, so
  // they are read from `Intl` rather than written here.
  assert.equal(pluralCategory(1, "bg"), "one");
  assert.equal(pluralCategory(2, "bg"), "other");
  assert.equal(pluralCategory(5, "bg"), "other");
  assert.equal(pluralCategory(21, "bg"), "other");
  assert.equal(pluralCategory(11, "bg"), "other");
});

test("the link's lifetime is written in the reader's language", () => {
  const units = getDictionary("en").checkout.success.units;
  const bgUnits = getDictionary("bg").checkout.success.units;
  assert.equal(ttlPhrase(86_400, units, "en"), "1 day");
  assert.equal(ttlPhrase(2 * 86_400, units, "en"), "2 days");
  assert.equal(ttlPhrase(86_400, bgUnits, "bg"), "1 ден");
  assert.equal(ttlPhrase(2 * 86_400, bgUnits, "bg"), "2 дни");
  assert.equal(ttlPhrase(5 * 86_400, bgUnits, "bg"), "5 дни");
  assert.equal(ttlPhrase(3_600, bgUnits, "bg"), "1 час");
  assert.equal(ttlPhrase(2 * 3_600, bgUnits, "bg"), "2 часа");
  assert.equal(ttlPhrase(90, bgUnits, "bg"), "2 минути");
  // The unit is never a raw seconds count.
  assert.equal(ttlPhrase(45, units, "en"), "1 minute");
});

test("the ready-download sentence's holes are filled in the reader's language", () => {
  // The sentence is the dictionary's; the numbers are the deployment's. Filling
  // the holes must leave no placeholder behind and must not touch the words.
  const bg = getDictionary("bg").checkout.success;
  const uses = pluralUnit(3, bg.units.time, "bg");
  const ttl = ttlPhrase(2 * 86_400, bg.units, "bg");
  const sentence = fillDownloadSentence(
    bg.states["digital-ready"],
    { uses, ttl },
  );
  assert.match(
    sentence,
    /Файлът ви е готов\. Връзката може да се използва 3 пъти и изтича след 2 дни\./,
  );
  assert.equal(sentence.includes("{uses}"), false);
  assert.equal(sentence.includes("{ttl}"), false);
});

test("the count and its unit are one phrase, in the reader's language", () => {
  const units = getDictionary("en").checkout.success.units;
  const bgUnits = getDictionary("bg").checkout.success.units;
  assert.equal(pluralUnit(3, units.time, "en"), "3 times");
  assert.equal(pluralUnit(1, units.time, "en"), "1 time");
  assert.equal(pluralUnit(3, bgUnits.time, "bg"), "3 пъти");
  assert.equal(pluralUnit(1, bgUnits.time, "bg"), "1 път");
});

test("the hosted checkout line is in the buyer's language", () => {
  // The words we own: the description, the digital line and the shipping
  // option's name. The provider's shell around them is not ours.
  assert.equal(physicalDescription("30x40", "black", "en"), "30x40 · black frame");
  assert.equal(physicalDescription("30x40", "black", "bg"), "30x40 · черна рамка");
  assert.equal(physicalDescription("30x40", null, "bg"), "30x40");
  assert.equal(digitalDescription("en"), "Digital high-resolution license");
  assert.equal(digitalDescription("bg"), "Цифров файл с висока разделителна способност");
  assert.equal(shippingDisplayName("en"), "Shipping");
  assert.equal(shippingDisplayName("bg"), "Доставка");
});

test("every state the success page can be in has a sentence in every locale", () => {
  // The dictionary's type says so; this says it again at runtime, because the
  // state list is the page's and the dictionary's key set is a Record of it —
  // and a hole in it would be a state the page renders in English.
  for (const locale of ["en", "bg"] as const) {
    const states = getDictionary(locale).checkout.success.states;
    const expected = [
      "missing-session",
      "invalid-session",
      "unavailable",
      "processing",
      "physical",
      "physical-unfulfilled",
      "digital-ready",
      "digital-pending",
      "digital-unavailable",
      "revoked",
      "digital-no-token",
    ];
    assert.deepEqual(Object.keys(states).sort(), expected.slice().sort(), locale);
    for (const [state, sentence] of Object.entries(states)) {
      assert.ok(sentence.length > 0, `${locale}/${state} has no sentence`);
    }
  }
});
