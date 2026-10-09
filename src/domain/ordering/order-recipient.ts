/**
 * The recipient fields a physical order carries, as domain data.
 *
 * Moved from `infrastructure/prodigi/prodigi-order.ts` so `order-decision.ts`
 * (domain) can type the `recipient` it parses from KV without an
 * `eslint-disable import/no-restricted-paths` that reached into infra.
 */
export type OrderRecipient = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postcode: string;
  countryCode: string;
  email: string | null;
  phone: string | null;
};
