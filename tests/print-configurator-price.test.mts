/**
 * The digital price is spelled one way in the configurator.
 *
 * The widget showed the same price two ways: the price row rendered
 * `€30.00` and the Digital Copy card rendered `· €30`, seventy lines apart in
 * the same file. Both spellings came from one commit, which converted the
 * price row to two decimals and wrote the card line without them -- so the
 * card was an oversight, not a compact style.
 *
 * The assertion is on the rendered markup, through the `.tsx` load hook (#420),
 * so it is the widget's two prices and not the source text that has to agree.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PrintConfigurator } from "../src/components/PrintConfigurator.tsx";
import { shipToCountriesFor } from "../src/domain/pricing/ship-to-countries.ts";
import { getDictionary } from "../src/components/i18n/dictionaries.ts";
import { DIGITAL_PRICE_EUR } from "../src/domain/pricing/pricing.ts";
import type { PrintOffer } from "../src/domain/catalog/print-offer.ts";
import type { MasterFacts } from "../src/domain/catalog/master-facts.ts";
import type { PrintSelection } from "../src/domain/ordering/print-selection.ts";

const MASTER: MasterFacts = {
  width: 3000,
  height: 2000,
  orientation: "landscape",
};

const OFFER: PrintOffer = {
  giclee: ["50x70"],
  framed: ["50x70"],
  canvas: ["50x70"],
};

const DIGITAL: PrintSelection = {
  format: "digital",
  size: "50x70",
  frame: "black",
  mount: "white",
  paper: "ema",
};

function markup(selection: PrintSelection, locale: "en" | "bg" = "en"): string {
  return renderToStaticMarkup(
    createElement(PrintConfigurator, {
      photoSlug: "a-photo",
      title: "A photo",
      offer: OFFER,
      master: MASTER,
      selection,
      onSelectionChange: () => {},
      locale,
      copy: getDictionary(locale).configurator,
      countries: shipToCountriesFor(locale),
    }),
  );
}

test("the digital price is the same string in the price row and the format card", () => {
  const html = markup(DIGITAL);
  const price = `€${DIGITAL_PRICE_EUR.toFixed(2)}`;

  // The price row, and the card that names the same price: two spellings of
  // one amount in one widget is the bug this pins.
  assert.ok(html.includes(price), `the configurator never renders ${price}`);
  // A bare amount, with no decimals after it. The lookahead is what keeps
  // "€30.00" from counting as a bare "€30".
  assert.doesNotMatch(
    html,
    /€30(?![\d.,])/,
    `the configurator renders a bare €${DIGITAL_PRICE_EUR} next to ${price}`,
  );

  // Both places, so the fix is not one of the two.
  assert.equal(html.split(price).length - 1, 2, "the price must appear twice");
});
