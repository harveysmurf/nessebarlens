/**
 * The one place environment and Worker bindings are read.
 *
 * Every other module in src/lib takes its configuration as an argument, so
 * "which env var backs this?" has exactly one answer and the answer lives in
 * one file. Two things stay deliberately outside:
 *
 *   - prodigi-config.ts, which owns the throw grammar and the 503/502
 *     classification. config.ts *delegates* to its validated readers rather
 *     than absorbing them: the classification is built from the same strings
 *     the throw sites build, and moving the readers away from the predicate
 *     would split those halves. See #119.
 *   - worker-bindings.ts, which can only read the Worker env asynchronously
 *     (getCloudflareContext), so it is a separate async surface owned by the
 *     same concern.
 *
 * Nothing here throws on a missing Prodigi value, and that is load-bearing
 * rather than cautious. getConfig is called at the top of route handlers,
 * above the `try` that classifies a Prodigi failure with prodigiFailure(): an
 * eager throw there would short-circuit the classification and report a
 * misconfigured deployment as a 502 — sending the operator to Prodigi's
 * status page for a bug that is ours. So the summary here is the
 * non-throwing prodigiKeyConfigured; the throwing readers stay at the call
 * site, inside the try.
 */

import { envFlag, envString, envStringStrippedSlash, stripTrailingSlashes } from "./env";
import {
  prodigiApiKey as prodigiApiKeyOf,
  prodigiKeyConfigured,
  prodigiOrdersUrl as prodigiOrdersUrlOf,
  prodigiQuotesUrl as prodigiQuotesUrlOf,
} from "./prodigi-config";

export type ConfigEnv = Record<string, unknown>;

/**
 * What this deployment is configured to do. Every field is resolved through
 * the existing validated readers, so a value here is byte-identical to what
 * the feature that consumes it would have read for itself.
 */
export type Config = {
  /**
   * The site origin, or undefined when unset/blank. Undefined rather than a
   * throw and rather than a localhost default: a caller that needs the
   * build-time answer uses siteUrl(), which applies the dev fallback, and a
   * route that must decide before it resolves uses isConfiguredSiteUrl().
   */
  siteUrl: string | undefined;
  stripe: {
    /** Undefined when unset. The Stripe client still throws; see getStripe. */
    secretKey: string | undefined;
  };
  prodigi: {
    /**
     * The API base, or undefined when unset or not an allowlisted host. Like
     * keyConfigured this never throws: prodigiApiBase() is the throwing
     * reader and stays at the call site, so its message and the allowlist
     * stay in one file.
     */
    apiBase: string | undefined;
    keyConfigured: boolean;
  };
  printAsset: {
    /** null when unset or shorter than the HMAC minimum — never a default. */
    secret: string | null;
  };
  flags: {
    webDerivativesEnabled: boolean;
  };
};

/**
 * The public origin for the web-derivative ladder, or undefined when unset,
 * not a URL, or not https.
 *
 * Moved out of derivatives.ts, which is otherwise pure URL construction. It is
 * an env read, and derivatives.ts now asks for the base instead of going and
 * finding it.
 */
export function webImagesBase(
  env: ConfigEnv = process.env,
): string | undefined {
  const raw = envString("NEXT_PUBLIC_WEB_IMAGES_BASE", env);
  if (!raw) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  return stripTrailingSlashes(`${url.origin}${url.pathname}`);
}

/**
 * The ladder is off unless explicitly enabled; the base URL being configured
 * does not turn it on. Both buckets were empty while the base was set in every
 * environment, so "base is set" cannot mean "files exist".
 */
export function webDerivativesEnabled(env: ConfigEnv = process.env): boolean {
  return envFlag("NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED", env);
}

/**
 * Whether NODE_ENV says production. Read through envString so a padded value
 * ("production ") counts, like every other reader.
 */
export function isProduction(env: ConfigEnv = process.env): boolean {
  return envString("NODE_ENV", env) === "production";
}

/** The configured site URL, or undefined — no fallback, no throw. */
export function configuredSiteUrl(
  env: ConfigEnv = process.env,
): string | undefined {
  return envStringStrippedSlash("NEXT_PUBLIC_SITE_URL", env);
}

/**
 * Absolute origin, never trailing-slashed — callers concatenate paths onto it.
 *
 * The localhost fallback is dev-only on purpose. NEXT_PUBLIC_* is inlined at
 * build time, so a production build missing the variable would otherwise ship
 * a checkout that redirects to http://localhost:3000 and Prodigi orders whose
 * signed asset URL points at localhost. Throwing keeps the failure on our side
 * of the request: /api/checkout turns it into a 503 before any money moves.
 *
 * Sync by necessity: src/app/layout.tsx calls the same resolution from
 * module-scope `metadata`, which is evaluated at build time where the async
 * Worker context does not exist. That is why this module owns a sync surface
 * *and* delegates the async binding read, rather than pretending one pure
 * getConfig covers both.
 */
export function siteUrl(env: ConfigEnv = process.env): string {
  const configured = configuredSiteUrl(env);
  if (configured) return configured;
  if (isProduction(env)) {
    throw new Error("NEXT_PUBLIC_SITE_URL is not set");
  }
  return "http://localhost:3000";
}

/**
 * isConfiguredSiteUrl, for callers that need to decide before they resolve the
 * URL: a route must return 503, not build a Stripe session it will discard.
 */
export function isConfiguredSiteUrl(env: ConfigEnv = process.env): boolean {
  return configuredSiteUrl(env) !== undefined;
}

/**
 * Min chars for the print-asset HMAC secret. Single source of truth.
 *
 * Lives with the reader rather than with the signing code because "usable" is
 * the question, and the signer and the verifier must answer it identically.
 */
export const PRINT_ASSET_SECRET_MIN_LENGTH = 32;

/**
 * A secret is usable only if it survives trimming and is long enough.
 *
 * A Worker binding can hold a value no env reader would produce — `wrangler
 * secret put` keeps a trailing newline, and a paste can carry a leading space.
 * "   " is truthy, so a bare length check signed URLs with a key of whitespace
 * and every legitimate request came back 401 bad-signature instead of the 503
 * that says the deployment is not configured.
 */
export function usablePrintAssetSecret(
  secret: string | null | undefined,
): string | null {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= PRINT_ASSET_SECRET_MIN_LENGTH ? trimmed : null;
}

/**
 * HMAC secret for /api/print-asset. Min 32 chars; unset returns null, which
 * callers read as "not configured" rather than as a usable default — see
 * signPrintAssetUrl for why there is no placeholder path here.
 *
 * Exactly one resolution path, so no caller may write a second bare
 * `?? printAssetSecret()`: this reader already ends in a process.env read
 * inside envString, so a null here means the value is absent from both the
 * Worker env and process.env. A second call as a "fallback" could only ever
 * return the same null.
 */
export function printAssetSecret(
  env: ConfigEnv = process.env,
): string | null {
  return usablePrintAssetSecret(envString("PRINT_ASSET_HMAC_SECRET", env));
}

/**
 * The deployment's own environment, for a function whose own signature carries
 * a default and must not spell process.env itself.
 */
export function defaultEnv(): ConfigEnv {
  return process.env;
}

/**
 * The deployment's own environment, for callers that must reach an env read
 * they are not allowed to make themselves.
 *
 * prodigi-config.ts is a pure function of the env it is handed (#119), so the
 * three Prodigi clients — quote, order, cancel — cannot call it directly any
 * more without re-introducing `env = process.env` in a fourth module. These
 * wrappers are that read, stated once, and they delegate: the throw grammar and
 * the allowlist still live in prodigi-config.ts, so nothing about the 503/502
 * classification moved. They throw, and callers must still call them inside
 * their try — see the module docblock.
 */
export function prodigiQuotesUrl(env: ConfigEnv = process.env): string {
  return prodigiQuotesUrlOf(env);
}

export function prodigiOrdersUrl(env: ConfigEnv = process.env): string {
  return prodigiOrdersUrlOf(env);
}

export function prodigiApiKey(env: ConfigEnv = process.env): string {
  return prodigiApiKeyOf(env);
}

/** The Stripe secret, or undefined. The Stripe client still throws; see getStripe. */
export function stripeSecretKey(env: ConfigEnv = process.env): string | undefined {
  return envString("STRIPE_SECRET_KEY", env);
}

/** Every configured value, resolved once. Never throws. */
export function getConfig(env: ConfigEnv = process.env): Config {
  return {
    siteUrl: configuredSiteUrl(env),
    stripe: { secretKey: stripeSecretKey(env) },
    prodigi: {
      // The non-throwing pair on purpose — see the module docblock.
      apiBase: envStringStrippedSlash("PRODIGI_API_BASE", env),
      keyConfigured: prodigiKeyConfigured(env),
    },
    // Delegates rather than re-reading PRINT_ASSET_HMAC_SECRET: the
    // minimum-length rule and its trimming live in print-asset.ts because the
    // signer and the verifier must agree on what "usable" means, and a second
    // copy of that rule here would be a second answer.
    printAsset: { secret: printAssetSecret(env) },
    flags: {
      webDerivativesEnabled: envFlag("NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED", env),
    },
  };
}

/**
 * Everything production needs and this deployment does not have, as a list.
 *
 * A report rather than a throw, because the AC is "missing production config
 * produces one clear error" and the shape a caller wants differs: a route has
 * a 503 body, a deploy check wants a message. productionConfigError() is the
 * message form.
 */
export function missingProductionConfig(
  env: ConfigEnv = process.env,
): string[] {
  const config = getConfig(env);
  const missing: string[] = [];
  if (config.siteUrl === undefined) missing.push("NEXT_PUBLIC_SITE_URL");
  if (config.stripe.secretKey === undefined) missing.push("STRIPE_SECRET_KEY");
  if (config.prodigi.apiBase === undefined) missing.push("PRODIGI_API_BASE");
  if (!config.prodigi.keyConfigured) missing.push("PRODIGI_API_KEY");
  if (config.printAsset.secret === null) missing.push("PRINT_ASSET_HMAC_SECRET");
  return missing;
}

/** The one message an operator gets for a misconfigured production deploy. */
export function productionConfigError(missing: string[] = missingProductionConfig()): string {
  return `Missing production config: ${missing.join(", ")}`;
}
