/**
 * Ship-to countries for physical prints.
 *
 * Generated from tests/fixtures/prodigi/products.json by
 * scripts/generate-ship-to-countries.mjs (#296):
 * 1. Intersection of the captured variants' `shipsTo` across the pinned
 *    SKUs.
 * 2. Filtered to Stripe Checkout `ShippingAddressCollection.AllowedCountry`
 *    (the `stripe` SDK's Sessions.d.ts).
 *
 * Re-generate with `node scripts/generate-ship-to-countries.mjs`; `--check`
 * compares without writing.
 */
import {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  type Locale,
} from "../i18n/locale";

// BEGIN GENERATED (scripts/generate-ship-to-countries.mjs)
export const SHIP_TO_COUNTRIES = [
  { code: "AF", name: "Afghanistan" },
  { code: "AX", name: "Åland Islands" },
  { code: "AL", name: "Albania" },
  { code: "DZ", name: "Algeria" },
  { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" },
  { code: "AI", name: "Anguilla" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "AR", name: "Argentina" },
  { code: "AM", name: "Armenia" },
  { code: "AW", name: "Aruba" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" },
  { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" },
  { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" },
  { code: "BM", name: "Bermuda" },
  { code: "BT", name: "Bhutan" },
  { code: "BO", name: "Bolivia" },
  { code: "BA", name: "Bosnia & Herzegovina" },
  { code: "BW", name: "Botswana" },
  { code: "BR", name: "Brazil" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "BN", name: "Brunei" },
  { code: "BG", name: "Bulgaria" },
  { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" },
  { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" },
  { code: "CV", name: "Cape Verde" },
  { code: "KY", name: "Cayman Islands" },
  { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" },
  { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" },
  { code: "KM", name: "Comoros" },
  { code: "CG", name: "Congo - Brazzaville" },
  { code: "CD", name: "Congo - Kinshasa" },
  { code: "CK", name: "Cook Islands" },
  { code: "CR", name: "Costa Rica" },
  { code: "CI", name: "Côte d’Ivoire" },
  { code: "HR", name: "Croatia" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" },
  { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" },
  { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" },
  { code: "ET", name: "Ethiopia" },
  { code: "FK", name: "Falkland Islands" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "GF", name: "French Guiana" },
  { code: "PF", name: "French Polynesia" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" },
  { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Greece" },
  { code: "GL", name: "Greenland" },
  { code: "GD", name: "Grenada" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GU", name: "Guam" },
  { code: "GT", name: "Guatemala" },
  { code: "GG", name: "Guernsey" },
  { code: "GN", name: "Guinea" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong SAR China" },
  { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" },
  { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" },
  { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" },
  { code: "IM", name: "Isle of Man" },
  { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" },
  { code: "JE", name: "Jersey" },
  { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" },
  { code: "KI", name: "Kiribati" },
  { code: "XK", name: "Kosovo" },
  { code: "KW", name: "Kuwait" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" },
  { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" },
  { code: "LY", name: "Libya" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MO", name: "Macao SAR China" },
  { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" },
  { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MU", name: "Mauritius" },
  { code: "YT", name: "Mayotte" },
  { code: "MX", name: "Mexico" },
  { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" },
  { code: "MS", name: "Montserrat" },
  { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" },
  { code: "MM", name: "Myanmar (Burma)" },
  { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" },
  { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" },
  { code: "NC", name: "New Caledonia" },
  { code: "NZ", name: "New Zealand" },
  { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NU", name: "Niue" },
  { code: "MK", name: "North Macedonia" },
  { code: "NO", name: "Norway" },
  { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" },
  { code: "PS", name: "Palestinian Territories" },
  { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "PR", name: "Puerto Rico" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" },
  { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "WS", name: "Samoa" },
  { code: "SM", name: "San Marino" },
  { code: "ST", name: "São Tomé & Príncipe" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" },
  { code: "RS", name: "Serbia" },
  { code: "SC", name: "Seychelles" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" },
  { code: "SX", name: "Sint Maarten" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" },
  { code: "KR", name: "South Korea" },
  { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" },
  { code: "BL", name: "St. Barthélemy" },
  { code: "SH", name: "St. Helena" },
  { code: "KN", name: "St. Kitts & Nevis" },
  { code: "LC", name: "St. Lucia" },
  { code: "MF", name: "St. Martin" },
  { code: "VC", name: "St. Vincent & Grenadines" },
  { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TG", name: "Togo" },
  { code: "TO", name: "Tonga" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "TN", name: "Tunisia" },
  { code: "TR", name: "Türkiye" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TC", name: "Turks & Caicos Islands" },
  { code: "TV", name: "Tuvalu" },
  { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "VU", name: "Vanuatu" },
  { code: "VA", name: "Vatican City" },
  { code: "VE", name: "Venezuela" },
  { code: "VN", name: "Vietnam" },
  { code: "WF", name: "Wallis & Futuna" },
  { code: "YE", name: "Yemen" },
  { code: "ZM", name: "Zambia" },
  { code: "ZW", name: "Zimbabwe" },
] as const;
// END GENERATED

export type ShipToCountryCode = (typeof SHIP_TO_COUNTRIES)[number]["code"];

export const SHIP_TO_COUNTRY_CODES = SHIP_TO_COUNTRIES.map(
  (c) => c.code,
) as ShipToCountryCode[];

/** Same list Stripe Checkout may receive (selector + validation source). */
export const STRIPE_SHIP_TO_COUNTRIES = SHIP_TO_COUNTRY_CODES;

/** Default shipping destination (Nessebar / store home). */
export const DEFAULT_SHIPPING_COUNTRY: ShipToCountryCode = "BG";

/**
 * Two-letter ISO country code. Owned here because three modules validate one:
 * checkout-body.ts (client input) and twice in fulfillment.ts (the stored
 * recipient) all validate against this one literal, not a copy each.
 */
export const ISO_ALPHA2_PATTERN = /^[A-Z]{2}$/;

const SHIP_TO_SET = new Set<string>(SHIP_TO_COUNTRY_CODES);

/** Bulgarian country names use the site's preferred short forms. */
const BULGARIAN_COUNTRY_NAMES: Partial<Record<ShipToCountryCode, string>> = {
  BN: "Бруней",
  SV: "Ел Салвадор",
  HK: "Хонг Конг",
  MM: "Мианма (Бирма)",
  IM: "Остров Ман",
  CK: "Острови Кук",
  TC: "Търкс и Кайкос",
  TL: "Източен Тимор",
  SH: "Света Елена",
  US: "САЩ",
  GB: "Великобритания",
  CG: "Конго (Бразавил)",
  CD: "Конго (Киншаса)",
  RE: "Реюнион",
};

export function isShipToCountryCode(code: string): code is ShipToCountryCode {
  return SHIP_TO_SET.has(code);
}

/**
 * A country as the selector shows it, in the reader's language.
 *
 * The names in the generated list are English, because that is the language the
 * generator ran `Intl.DisplayNames` in. A Bulgarian reader is offered the
 * country they are shipping to by its own name, so the name is derived from
 * the ISO code at render time rather than stored: the code is the fact, and the
 * name is the locale's word for it.
 *
 * The code is what is submitted and what reaches Prodigi and Stripe — the name
 * never leaves the browser, and `ISO_ALPHA2_PATTERN` still validates the code
 * the server receives.
 *
 * There is no fallback to the raw code, and that is a decision rather than an
 * oversight: ICU names every ISO 3166-1 alpha-2 code the list holds, and a
 * branch that cannot be taken is a branch nobody has ever run.
 * `tests/i18n-storefront.test.mts` holds the invariant instead — every shipped
 * code has a name in every locale — so a code ICU does not know is a test
 * failure rather than a selector offering a visitor "BJ".
 */
export function countryName(
  code: ShipToCountryCode,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (locale === "bg" && BULGARIAN_COUNTRY_NAMES[code]) {
    return BULGARIAN_COUNTRY_NAMES[code];
  }
  const names = new Intl.DisplayNames([LOCALE_TAGS[locale]], { type: "region" });
  // The `!` is the type saying what the runtime already knows: the code is an
  // ISO 3166-1 alpha-2 region and ICU names every one of them. `of()` is typed
  // as possibly undefined because it takes any string, and a code that was not
  // a region would be one — this list holds none.
  return names.of(code)!;
}

/** One destination, as the selector shows it. */
export type ShipToCountry = { code: ShipToCountryCode; name: string };

/**
 * The destination list, in the reader's language.
 *
 * Built on the server and handed to the client, because the names come from
 * ICU and the server's ICU and the browser's are not the same version: a name
 * the server renders and the client re-derives can differ, and React calls
 * that a hydration mismatch and regenerates the tree. The server decides the
 * words and the client renders them, so the two cannot disagree — and the
 * browser's ICU data stays out of the bundle.
 */
export function shipToCountriesFor(
  locale: Locale = DEFAULT_LOCALE,
): ShipToCountry[] {
  const countries = SHIP_TO_COUNTRIES.map((country) => ({
    code: country.code,
    name: countryName(country.code, locale),
  }));
  if (locale !== "bg") return countries;

  const collator = new Intl.Collator("bg");
  return countries.sort(
    (a, b) => collator.compare(a.name, b.name) || a.code.localeCompare(b.code),
  );
}
