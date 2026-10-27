import {
  isLocale,
  LOCALES,
  PUBLIC_LOCALES,
  type Locale,
} from "../../domain/i18n/locale";
import { envString, type EnvReader } from "../config/env";

/**
 * The locales this build serves.
 *
 * The site's served set is `PUBLIC_LOCALES` — English, until the contact and
 * checkout slices land. A Bulgarian URL that served English copy would be
 * worse than no Bulgarian URL at all: a crawler would index it, a visitor
 * would be told the site is in Bulgarian and find it is not.
 *
 * **The guard cannot be lifted by an environment variable.** A production build
 * serves exactly `PUBLIC_LOCALES`, whatever the environment says, so a stray
 * variable on a deploy host cannot publish a half-translated site. The
 * override exists for the one thing the guard makes impossible otherwise:
 * reaching the Bulgarian tree before it is published.
 *
 * Outside a production build — the dev server, the e2e job — `SERVE_LOCALES`
 * adds locales to the served set. That is how the Bulgarian pages are tested
 * while they are still unpublished: a browser has to be able to open them for
 * the e2e flow to mean anything.
 *
 * The variable is a comma-separated list of locales, and a name the site does
 * not know is an error rather than a silent skip: a typo that quietly served
 * nothing would leave the e2e running against the English tree and calling it
 * green.
 *
 * The environment is a parameter rather than read here, so this is a pure
 * function of what it is handed — the same shape every other env reader in
 * `src/` has, and the reason `tests/config-reads-env.test.mts` can hold that
 * only three modules read the environment.
 */
export function servedLocales(env: EnvReader): readonly Locale[] {
  if (envString("NODE_ENV", env) === "production") return PUBLIC_LOCALES;

  const requested = envString("SERVE_LOCALES", env);
  if (!requested) return PUBLIC_LOCALES;

  const extra: Locale[] = [];
  for (const name of requested.split(",")) {
    const locale = name.trim();
    if (!locale) continue;
    if (!isLocale(locale)) {
      throw new Error(
        `SERVE_LOCALES names "${locale}", which is not a locale the site knows ` +
          `(${LOCALES.join(", ")}).`,
      );
    }
    const served: readonly Locale[] = PUBLIC_LOCALES;
    if (!served.includes(locale) && !extra.includes(locale)) {
      extra.push(locale);
    }
  }
  return [...PUBLIC_LOCALES, ...extra];
}
