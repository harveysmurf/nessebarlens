-- Orders + download tokens (#116).
-- Applied with: npx wrangler d1 migrations apply nessebar-lens-orders [--local|--remote]
--
-- `record` / `index_record` hold the JSON so order-decision.ts and
-- download-token.ts stay the only parsers. Columns beside them are an index
-- over that JSON (or the optimistic-lock counter), never a second shape.

CREATE TABLE orders (
  session_id  TEXT PRIMARY KEY,
  -- The full OrderRecord JSON, verbatim. Columns below are an index over it,
  -- never a second source of truth: order-decision.ts owns the shape and
  -- parseOrderRecord stays the only parser.
  record      TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  terminal    INTEGER NOT NULL,   -- 0/1
  reason      TEXT,
  attempts    INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);
-- listOrders({ retryable: true }): status = 'paid-unfulfilled' AND terminal = 0
CREATE INDEX orders_retryable ON orders (status, terminal);
-- listOrders({ status: [...] }) / operator --status filter
CREATE INDEX orders_status    ON orders (status);
-- listOrders ordered by age; stuck-order ageHours
CREATE INDEX orders_created   ON orders (created_at);

CREATE TABLE download_tokens (
  token        TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  -- Unix seconds, as DownloadTokenRecord.expiresAt already is.
  expires_at   INTEGER NOT NULL,
  max_downloads INTEGER NOT NULL,
  -- Downloads still available (what the JSON calls `remaining`).
  downloads    INTEGER NOT NULL,
  record       TEXT NOT NULL,
  -- `{...record, token}` reverse index, stored rather than reconstructed.
  index_record TEXT NOT NULL
);
-- findDownloadToken(sessionId) / success-page reverse lookup
CREATE INDEX download_tokens_session ON download_tokens (session_id);
