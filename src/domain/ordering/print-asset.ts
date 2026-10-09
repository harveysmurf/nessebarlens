/**
 * Print-asset secret validation, owned by the domain.
 *
 * `usablePrintAssetSecret` and `PRINT_ASSET_SECRET_MIN_LENGTH` moved here from
 * `infrastructure/config/config.ts` so the application layer can validate its own
 * inputs without importing infrastructure. `config.ts` imports these back from
 * domain — infra→domain is the correct direction.
 */

/** Min chars for the print-asset HMAC secret. Single source of truth. */
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
