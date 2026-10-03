-- Prodigi CloudEvent callback dedupe (#117).
-- Applied with: npx wrangler d1 migrations apply nessebar-lens-orders [--local|--remote]
--
-- Prodigi v4 sends no HMAC and documents no retry bound. The event `id` is the
-- only uniqueness claim we get, so claiming it here is what makes a redelivery
-- a no-op instead of a second stage write / second customer email.

CREATE TABLE prodigi_callbacks (
  event_id    TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
