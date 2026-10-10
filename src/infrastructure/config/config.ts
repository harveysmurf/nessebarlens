/**
 * The one place environment and Worker bindings are read.
 *
 * Every other module in src/application and src/domain takes its configuration as an argument, so
 * "which env var backs this?" has exactly one answer and the answer lives in
 * one file. Two things stay deliberately outside:
 *
 *   - prodigi-config.ts, which owns the Prodigi configuration read and the
 *     kind→status mapping. config.ts *delegates* to its validated readers
 *     rather than absorbing them: `readProdigiConfig` is a pure function of
 *     the env it is handed, and config.ts is the only module that reaches
 *     process.env for Prodigi. See #119.
 *   - worker-bindings.ts, which can only read the Worker env asynchronously
 *     (getCloudflareContext), so it is a separate async surface owned by the
 *     same concern.
 *
 * Nothing here throws on a missing Prodigi value, and that is load-bearing
 * rather than cautious. getConfig is called at the top of route handlers,
 * above where a failed Prodigi result is classified into a 503/502 by
 * prodigiFailureFrom(): an eager throw there would short-circuit the
 * classification and report a misconfigured deployment as a 502 — sending the
 * operator to Prodigi's status page for a bug that is ours. So the summary
 * here is the non-throwing prodigiKeyConfigured, and the clients read the
 * configuration through the non-throwing `prodigiConfig` wrapper below.
 */

import {
  envIntInRange,
  envString,
  envStringStrippedSlash,
} from "./env";
import { stripTrailingSlashes } from "../../domain/pricing/url-patterns";
import {
  DOWNLOAD_TOKEN_MAX_DOWNLOADS,
  DOWNLOAD_TOKEN_TTL_SECONDS,
} from "../../domain/ordering/download-token";
import { usablePrintAssetSecret } from "../../domain/ordering/print-asset";
import {
  prodigiApiBaseIfAllowed,
  prodigiKeyConfigured,
  readProdigiConfig,
  type ProdigiConfigResult,
} from "../prodigi/prodigi-config";

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
     * The API base, or undefined when unset or not an allowlisted host — the
     * two ways a deployment is misconfigured. Like keyConfigured this never
     * throws: it delegates to prodigiApiBaseIfAllowed rather than re-reading
     * the variable, so "configured" has one answer. A wrong host therefore
     * reads as missing here, which is what makes missingProductionConfig able
     * to name it.
     */
    apiBase: string | undefined;
    keyConfigured: boolean;
  };
  printAsset: {
    /** null when unset or shorter than the HMAC minimum — never a default. */
    secret: string | null;
  };
  /**
   * Download-token limits (#111). Unlike every other field here these *do* have
   * defaults: they are policy, not credentials, and an unset value must not
   * mean "unlimited" or "already expired". A bad value falls back to the default
   * rather than throwing, for the same reason nothing else on a paid path is
   * made to throw by getConfig — a typo in an optional var must not take a
   * download endpoint offline.
   */
  download: {
    tokenTtlSeconds: number;
    maxDownloads: number;
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
 * HMAC secret for /api/print-asset. Min 32 chars; unset returns null, which
 * callers read as "not configured" rather than as a usable default — see
 * the AssetUrlSigner port for why there is no placeholder path here.
 *
 * Uses `usablePrintAssetSecret` from `domain/ordering/print-asset` — the signer
 * and the verifier must agree on what "usable" means, and a second copy of that
 * rule here would be a second answer.
 */
export function printAssetSecret(
  env: ConfigEnv = process.env,
): string | null {
  return usablePrintAssetSecret(envString("PRINT_ASSET_HMAC_SECRET", env));
}

/**
 * Bearer token Prodigi must present on /api/webhooks/prodigi, or undefined.
 * Read here, not in prodigi-order.ts, for the same reason prodigiConfig is:
 * the env read is stated once, in the allowlisted module. The order body
 * embeds it in the callback URL so the route's `?token=` check can pass.
 */
export function prodigiWebhookToken(
  env: ConfigEnv = process.env,
): string | undefined {
  return envString("PRODIGI_WEBHOOK_TOKEN", env);
}

/**
 * Operator-alert configuration (#309): the Resend key and the recipient
 * address. Both are optional — the alert adapter factory returns undefined when
 * either is missing, and the dispatch wrapper then logs
 * `operator-alert.undelivered` instead of throwing on a webhook path. Read here,
 * not in container.ts, so the env reads stay in the one allowlisted module.
 */
export function operatorAlertConfig(env: ConfigEnv = process.env): {
  apiKey: string | undefined;
  to: string | undefined;
} {
  return {
    apiKey: envString("RESEND_API_KEY", env),
    to: envString("OPERATOR_ALERT_EMAIL", env),
  };
}

/**
 * The public Turnstile site key (#293), or undefined when unset/blank.
 *
 * Public by definition — it is embedded in the contact page's HTML and is not a
 * secret. Read here rather than in the page so the env access stays in the one
 * allowlisted module. The contact page reads it at request time (the page is
 * `force-dynamic`), so a missing key disables the widget visibly instead of
 * rendering a broken challenge. Unlike `siteUrl`, an absent key is not fatal:
 * the rest of the site works without a contact form.
 */
export function turnstileSiteKey(env: ConfigEnv = process.env): string | undefined {
  return envString("NEXT_PUBLIC_TURNSTILE_SITE_KEY", env);
}

/**
 * The deployment's own Prodigi configuration, for callers that must reach an
 * env read they are not allowed to make themselves.
 *
 * prodigi-config.ts is a pure function of the env it is handed (#119), so the
 * three Prodigi clients — quote, order, cancel — cannot call it directly any
 * more without re-introducing `env = process.env` in a fourth module. This
 * wrapper is that read, stated once, and it delegates to readProdigiConfig so
 * the host/key pairing and the allowlist stay in one file. It returns a tagged
 * result rather than throwing: the caller branches on `ok` and maps a failure
 * to a 503 through prodigiFailureFrom, never by matching the message text.
 */
export function prodigiConfig(env: ConfigEnv = process.env): ProdigiConfigResult {
  return readProdigiConfig(env);
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
      apiBase: prodigiApiBaseIfAllowed(env),
      keyConfigured: prodigiKeyConfigured(env),
    },
    // Delegates rather than re-reading PRINT_ASSET_HMAC_SECRET: the
    // minimum-length rule and its trimming live in
    // domain/ordering/print-asset.ts (usablePrintAssetSecret) because the
    // signer and the verifier must agree on what "usable" means, and a
    // second copy of that rule here would be a second answer.
    printAsset: { secret: printAssetSecret(env) },
    download: {
      tokenTtlSeconds: envIntInRange(
        "DOWNLOAD_TOKEN_TTL_SECONDS",
        env,
        DOWNLOAD_TOKEN_TTL_SECONDS,
        60,
      ),
      maxDownloads: envIntInRange(
        "DOWNLOAD_TOKEN_MAX_DOWNLOADS",
        env,
        DOWNLOAD_TOKEN_MAX_DOWNLOADS,
        1,
      ),
    },
  };
}

/**
 * Everything production needs and this deployment does not have, as a list.
 *
 * A report rather than a throw, so a caller picks the shape: a route can build
 * a 503 body from it, a deploy check a message. The validation contract is
 * exercised by tests/config.test.mts; no production caller reads it yet, so
 * wire it up wherever a missing-config report is actually needed.
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
