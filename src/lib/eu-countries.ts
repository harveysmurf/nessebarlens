/** EU-27 only. Include BG. Exclude GB, CH, NO. */
export const EU_27_COUNTRIES = [
  { code: "AT", name: "Austria" },
  { code: "BE", name: "Belgium" },
  { code: "BG", name: "Bulgaria" },
  { code: "HR", name: "Croatia" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "EE", name: "Estonia" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "GR", name: "Greece" },
  { code: "HU", name: "Hungary" },
  { code: "IE", name: "Ireland" },
  { code: "IT", name: "Italy" },
  { code: "LV", name: "Latvia" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MT", name: "Malta" },
  { code: "NL", name: "Netherlands" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "RO", name: "Romania" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" },
] as const;

export type Eu27CountryCode = (typeof EU_27_COUNTRIES)[number]["code"];

export const EU_27_COUNTRY_CODES = EU_27_COUNTRIES.map(
  (c) => c.code,
) as Eu27CountryCode[];

/** Default shipping destination for quotes (Nessebar / store home). */
export const DEFAULT_SHIPPING_COUNTRY: Eu27CountryCode = "BG";

const EU_27_SET = new Set<string>(EU_27_COUNTRY_CODES);

export function isEu27CountryCode(code: string): code is Eu27CountryCode {
  return EU_27_SET.has(code);
}
