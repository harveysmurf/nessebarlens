/**
 * Generic Prodigi result type, owned by the domain.
 *
 * Moved from `infrastructure/prodigi/prodigi-config.ts` so the application
 * layer can type-check against `ProdigiResult<T>` without importing
 * infrastructure. The reason union (`ProdigiFailureReason`) already lives in
 * `prodigi-policy.ts` and is imported here.
 */

import type { ProdigiFailureReason } from "./prodigi-policy";

/**
 * How a failed Prodigi call is retried. The value is the failure's own shape,
 * not a name the caller matches against a message string.
 *
 * "server", "timeout" and "unconfigured" are all retryable and answered 5xx
 * by the webhook; "client" is a permanent failure answered 200.
 */
export type ProdigiFailureKind = "unconfigured" | "timeout" | "client" | "server";

/** One result type for every Prodigi caller — quote and order. */
export type ProdigiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: ProdigiFailureKind;
      reason: ProdigiFailureReason;
      message: string;
      status: number | null;
    };

/** The failed arm of `ProdigiResult`, the input a route hands to prodigiFailureFrom. */
export type ProdigiFailureBranch = Extract<ProdigiResult<never>, { ok: false }>;
