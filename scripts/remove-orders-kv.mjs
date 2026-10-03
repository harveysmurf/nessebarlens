#!/usr/bin/env node
/**
 * Removes the ORDERS KV namespace now that orders live in D1 (#178).
 *
 * The interesting part is not the deletion, it is the gate in front of it. The
 * migration (`npm run migrate:orders`) moved the data once; between then and
 * here the namespace may have received new orders, and a delete that trusts a
 * comment saying "parity verified" is a delete someone runs against a stale
 * claim. So coverage is measured live in this process, immediately before
 * anything is touched, and an unmigrated order refuses:
 *
 *   every completed order in KV   -> a row in D1 orders
 *   every download grant in KV    -> a row in D1 download_tokens
 *
 * The invariant is "no unmigrated completed order remains in KV", and the
 * discriminator is the key/value grammar the migrator already owns
 * (classifyKvKey + looksLikeOrderRecord), not a key count. A KV key only
 * matters if its value is an OrderRecord; `cs_test_` placeholders are
 * pre-payment session state, and neither is an order D1 still needs. Counting
 * keys instead would compare two sets that differ by construction and never
 * match. Download grants get their own leg for the same reason: the deletion
 * takes the whole namespace, so a gate that watched only orders would drop an
 * unmigrated `dl:` token on the way out.
 *
 * Nothing is deleted and wrangler.toml is not rewritten unless every
 * completed-order key is already in D1 AND the operator passed `--yes`, so a
 * bare invocation is a no-op rather than an accident.
 *
 * The run is also restartable. Deleting the namespaces and rewriting
 * wrangler.toml are separate steps, so a crash between them leaves the data
 * gone and the binding still named in the config — and re-running would then
 * find no namespace to count and stop on a gate it can never satisfy. When both
 * namespaces are already absent, that question is settled: the script says so
 * and finishes only the rewrite, without asking for `--yes` a second time.
 * Namespaces that are all still present are gated and deleted exactly as on a
 * first run. One of two surviving is neither: the gate can no longer see both
 * sides, so that state refuses and names itself rather than deleting on a
 * half-covered check.
 *
 * Usage:
 *   npm run orders:kv:remove              # checks KV order coverage, refuses unless --yes
 *   npm run orders:kv:remove -- --yes     # removes after the gate passes
 *
 * Sometimes the right answer for an unmigrated order is that it should never have
 * been in D1 — a Stripe test-mode record in the ephemeral preview namespace, for
 * instance. That is a decision, so it is not a way to get past the gate: it needs
 * `--write-off <session_id> <reason>`, the reason is mandatory, the disposition is
 * printed in the run summary, and a write-off the gate did not ask for is an error
 * rather than a silent pass.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
// The key and value grammar is owned by the migrator and the modules the live
// worker reads it from. This gate must ask the same question the migration
// asked, so it asks it with the same predicates: a gate that recognises a
// different set of keys than the migrator would either refuse forever or, worse,
// wave through an order the migrator would have carried over.
import { isDownloadToken } from "../src/lib/download-token.ts";
import { classifyKvKey, looksLikeOrderRecord } from "./migrate-orders-kv-to-d1.mjs";

export const DATABASE_NAME = "nessebar-lens-orders";
export const KV_BINDING = "ORDERS";
export const WRANGLER_TOML = "wrangler.toml";

export function parseArgs(argv) {
  let confirmed = false;
  const writeOffs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") confirmed = true;
    else if (arg === "--help" || arg === "-h") return { help: true, confirmed: false, writeOffs };
    else if (arg === "--write-off") {
      const sessionId = argv[i + 1];
      const reason = argv[i + 2];
      if (!sessionId || sessionId.startsWith("--")) {
        throw new Error("--write-off needs a session id");
      }
      if (!reason || reason.startsWith("--")) {
        throw new Error(`--write-off ${sessionId} needs a reason: dropping an order record is a decision, not a default`);
      }
      if (writeOffs.some((w) => w.sessionId === sessionId)) {
        throw new Error(`--write-off ${sessionId} given twice`);
      }
      writeOffs.push({ sessionId, reason });
      i += 2;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { help: false, confirmed, writeOffs };
}

/**
 * The [[kv_namespaces]] block for ORDERS, as the three fields the delete needs,
 * or null when the binding is not in the file.
 *
 * Hand-rolled rather than a TOML dependency: this is the only TOML shape in the
 * repo that has to be read and rewritten, and the file's ordering and comment
 * layout have to survive the edit byte-for-byte elsewhere, which a parse and
 * re-serialise cannot give us.
 */
export function parseOrdersKvBinding(text) {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "[[kv_namespaces]]") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (
      line === "[[kv_namespaces]]" ||
      /^\[{1,2}[a-z0-9_]+\]{1,2}$/.test(line)
    ) {
      end = i;
      break;
    }
  }

  const block = lines.slice(start, end);
  const value = (key) => {
    for (const line of block) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`));
      if (m) return m[1];
    }
    return null;
  };
  const binding = value("binding");
  if (binding !== KV_BINDING) return null;
  return { start, end, id: value("id"), previewId: value("preview_id"), block };
}

/**
 * The same file with the ORDERS block (and the comment above it, which exists
 * only to explain why the block is still there) removed. Any other binding,
 * comment and blank line is preserved exactly.
 */
export function removeOrdersKvBinding(text) {
  const found = parseOrdersKvBinding(text);
  if (!found) return { text, removed: false };

  // Comment lines directly above the block belong to it — they explain why the
  // binding is still present, which stops being true once it is gone.
  const lines = text.split("\n");
  let start = found.start;
  while (start > 0 && lines[start - 1].trim().startsWith("#")) start -= 1;
  lines.splice(start, found.end - start);
  return { text: lines.join("\n"), removed: true };
}

/**
 * KV keys whose value is a completed order record that D1 has no row for.
 *
 * Keys are classified with the migrator's grammar: `dl:`/`dls:` download state
 * and anything that is not a checkout-session key are not orders, and their
 * values are never fetched. A key whose value fails looksLikeOrderRecord is a
 * pre-payment placeholder or a corrupt blob, not an unmigrated order — that is
 * the same judgement the migrator makes, so the two agree by construction.
 */
export function findUnmigratedOrderKeys({ keys, readValue, d1Sessions }) {
  const migrated = new Set(d1Sessions);
  const unmigrated = [];
  for (const key of keys) {
    const kind = classifyKvKey(key);
    if (kind.kind !== "order") continue;
    if (migrated.has(kind.sessionId)) continue;
    if (looksLikeOrderRecord(readValue(key), kind.sessionId)) {
      unmigrated.push(kind.sessionId);
    }
  }
  return unmigrated;
}

/**
 * One column of a `select …` D1 result. An unreadable result returns null, never
 * []: an empty D1 side would make every KV record look unmigrated (safe) but an
 * absent check would be a check that was never run (not safe), so the caller
 * treats null as a failed gate.
 */
export function parseD1Column(stdout, column) {
  let parsed;
  try {
    parsed = JSON.parse(stdout || "null");
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : null;
  if (!entries) return null;
  const values = [];
  for (const entry of entries) {
    const rows = Array.isArray(entry?.results) ? entry.results : null;
    if (!rows) return null;
    for (const row of rows) {
      const value = row?.[column];
      if (typeof value !== "string" || !value) return null;
      values.push(value);
    }
  }
  return values;
}

export const parseD1Sessions = (stdout) => parseD1Column(stdout, "session_id");
export const parseD1Tokens = (stdout) => parseD1Column(stdout, "token");

/**
 * KV download tokens with no row in D1's download_tokens.
 *
 * The removal deletes the whole namespace, not just the order keys, so a gate
 * that watched only orders would drop an unmigrated download grant on the way
 * out — the same class of hole, one table over. `dl:` keys carry the grant;
 * the `dls:` keys beside them are reverse indexes the migrator derives from
 * those, so they are covered by the token check rather than separately.
 */
export function findUnmigratedTokens({ keys, d1Tokens }) {
  const migrated = new Set(d1Tokens);
  const unmigrated = [];
  for (const key of keys) {
    const kind = classifyKvKey(key);
    if (kind.kind !== "token") continue;
    if (!isDownloadToken(kind.token)) continue;
    if (!migrated.has(kind.token)) unmigrated.push(kind.token);
  }
  return unmigrated;
}

export function runRemove(argv, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const readFile = options.readFileSync ?? ((p) => readFileSync(p, "utf8"));
  const writeFile = options.writeFileSync ?? ((p, data) => writeFileSync(p, data));
  const listKvKeys = options.listKvKeys ?? defaultListKvKeys;
  const getKvValue = options.getKvValue ?? defaultGetKvValue;
  const listD1Sessions = options.listD1Sessions ?? defaultListD1Sessions;
  const listD1Tokens = options.listD1Tokens ?? defaultListD1Tokens;
  const deleteNamespace = options.deleteNamespace ?? defaultDeleteNamespace;
  const listNamespaceIds = options.listNamespaceIds ?? defaultListNamespaceIds;
  const tomlPath = options.tomlPath ?? WRANGLER_TOML;

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return { exitCode: 2, stdout: "", stderr: String(e instanceof Error ? e.message : e) };
  }
  if (parsed.help) {
    return {
      exitCode: 0,
      stdout:
        "Usage: node scripts/remove-orders-kv.mjs [--yes] [--write-off <session_id> <reason>]\n" +
        "\n" +
        "Checks that every completed order and download grant in KV ORDERS exists in D1,\n" +
        "and refuses to delete unless it does.\n\n" +
        "--write-off drops a specific unmigrated order that is deliberately not being\n" +
        "migrated (e.g. a Stripe test-mode record in the preview namespace). It requires a\n" +
        "reason, is printed in the run summary, and is rejected if the gate did not report\n" +
        "that order.\n",
      stderr: "",
    };
  }

  let toml;
  try {
    toml = readFile(tomlPath);
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: `cannot read ${tomlPath}: ${e.message}` };
  }
  const binding = parseOrdersKvBinding(toml);
  if (!binding) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `no [[kv_namespaces]] block for binding ${KV_BINDING} in ${tomlPath}: nothing for this script to remove. ` +
        "If a previous run deleted the namespaces but died before rewriting the file, finish by hand.",
    };
  }

  // Restartability: if a previous run deleted the namespaces and then died
  // before rewriting the config, the binding is still named here but the data
  // is gone. Gating on counts now could only ever fail (KV empty, D1 not), so
  // the already-deleted state is detected up front and only the rewrite runs.
  let present;
  try {
    present = new Set(listNamespaceIds(spawn));
  } catch (e) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${e instanceof Error ? e.message : String(e)} — cannot tell whether ${KV_BINDING} still exists; nothing was deleted.`,
    };
  }
  const ids = [binding.id, binding.previewId].filter(Boolean);
  const remaining = ids.filter((id) => present.has(id));
  const alreadyDeleted = remaining.length === 0;

  // Half-deleted is its own state and must not fall through to the gate: the
  // check reads the surviving namespace's keys, and the missing one is
  // exactly what the operator needs told plainly. Deleting the survivor on a
  // check that no longer covers the missing one is the one shape where we would
  // lose data silently, so this refuses and names the state instead.
  const gone = ids.filter((id) => !present.has(id));
  if (gone.length > 0 && remaining.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `${KV_BINDING} is half-removed: ${gone.join(", ")} no longer exist while ${remaining.join(", ")} ` +
        `still ${remaining.length === 1 ? "does" : "do"}. A key-level check can no longer cover both namespaces. ` +
        "Confirm the surviving namespace against D1, then delete it and the binding by hand. Nothing was deleted.",
    };
  }

  // The probe is account-scoped: absence means "absent from the account this
  // wrangler session is authenticated to". Run it on the deploy account, or
  // this branch would strip the binding while the namespaces survive elsewhere.
  if (alreadyDeleted) {
    return finishRewrite({
      tomlPath,
      writeFile,
      toml,
      summary: `orders:kv:remove already deleted ${ids.join(", ")}; completing the ${tomlPath} rewrite\n`,
    });
  }

  // Both namespaces are checked: the preview namespace is written by the same
  // worker path and a gate that only reads prod is a gate with a hole in it.
  const d1Sessions = listD1Sessions(spawn);
  if (d1Sessions === null) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "could not read the migrated orders from D1: refusing to delete on an unknown set of sessions",
    };
  }
  const d1Tokens = listD1Tokens(spawn);
  if (d1Tokens === null) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "could not read the migrated download tokens from D1: refusing to delete on an unknown set of tokens",
    };
  }

  // A key can exist in both the production and preview namespaces, and both are
  // checked against the same D1 set, so a shared id would otherwise be reported
  // and written off twice. Membership is what matters, so key on it.
  const unmigrated = new Set();
  const unmigratedTokens = new Set();
  let checked = 0;
  try {
    for (const id of remaining) {
      const kvKeys = listKvKeys(spawn, id);
      checked += kvKeys.length;
      for (const sessionId of findUnmigratedOrderKeys({
        keys: kvKeys,
        readValue: (key) => getKvValue(spawn, id, key),
        d1Sessions,
      })) {
        unmigrated.add(sessionId);
      }
      // The token leg reads key names only, so it is settled per namespace
      // here rather than per key inside the order check above.
      for (const token of findUnmigratedTokens({ keys: kvKeys, d1Tokens })) {
        unmigratedTokens.add(token);
      }
    }
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }

  // An order the operator has explicitly written off is not silently dropped: it
  // is named, matched to a required reason, and printed in the run summary so the
  // disposition is auditable after the namespaces are gone. A write-off that
  // matches nothing is an error rather than a no-op — a stale waiver left in a
  // runbook must not read as a clean gate.
  const waived = [];
  const unwaived = [];
  for (const sessionId of [...unmigrated]) {
    const waiver = parsed.writeOffs.find((w) => w.sessionId === sessionId);
    if (waiver) waived.push(waiver);
    else unwaived.push(sessionId);
  }
  const unused = parsed.writeOffs.filter(
    (w) => !waived.some((used) => used.sessionId === w.sessionId),
  );
  if (unused.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `--write-off names ${unused.map((w) => w.sessionId).join(", ")}, which the gate did not report as an unmigrated order. ` +
        "A write-off is only valid for an order the gate itself found; check the id. Nothing was deleted.",
    };
  }

  let summary = `orders:kv:remove gate ${JSON.stringify({
    d1Orders: d1Sessions.length,
    kvKeys: checked,
    unmigratedOrders: unwaived.length,
    unmigratedTokens: unmigratedTokens.size,
    writtenOff: waived.map((w) => w.sessionId),
  })}\n`;
  if (waived.length > 0) {
    const lines = waived.map((w) => `  ${w.sessionId}: ${w.reason}`).join("\n");
    summary += `written off by hand, NOT migrated (decision of record):\n${lines}\n`;
  }
  if (unwaived.length > 0) {
    return {
      exitCode: 1,
      stdout: summary,
      stderr:
        `gate failed: ${unwaived.length} KV key(s) hold a completed order with no row in D1: ` +
        `${unwaived.join(", ")}. Run npm run migrate:orders first, then re-check, or pass ` +
        `--write-off <session_id> <reason> for a record deliberately dropped. Nothing was deleted.`,
    };
  }
  if (unmigratedTokens.size > 0) {
    return {
      exitCode: 1,
      stdout: summary,
      stderr:
        `gate failed: ${unmigratedTokens.size} KV download token(s) have no row in D1 download_tokens: ` +
        `${[...unmigratedTokens].join(", ")}. Run npm run migrate:orders first, then re-check. Nothing was deleted.`,
    };
  }
  if (!parsed.confirmed) {
    return {
      exitCode: 1,
      stdout: summary,
      stderr:
        "no unmigrated order remains, but --yes was not passed: re-run with --yes to remove the namespace. Nothing was deleted.",
    };
  }

  const removed = [];
  for (const id of remaining) {
    try {
      deleteNamespace(spawn, id);
      removed.push(id);
    } catch (e) {
      return {
        exitCode: 1,
        stdout: summary,
        stderr:
          `${e instanceof Error ? e.message : String(e)} — ${removed.length} of ${remaining.length} namespaces deleted so far. ` +
          `${tomlPath} was NOT rewritten; finish the remaining delete by hand.`,
      };
    }
  }

  return finishRewrite({ tomlPath, writeFile, toml, summary, removed });
}

/**
 * Drop the ORDERS block from wrangler.toml. Factored out because the two
 * endings — first run and restart after a completed delete — do the same final
 * step and must not be able to drift apart.
 */
function finishRewrite({ tomlPath, writeFile, toml, summary, removed = [] }) {
  const edited = removeOrdersKvBinding(toml);
  writeFile(tomlPath, edited.text);
  const what =
    removed.length > 0
      ? `removed namespaces ${removed.join(", ")} and the ${KV_BINDING} binding from ${tomlPath}`
      : `removed the ${KV_BINDING} binding from ${tomlPath}`;
  return {
    exitCode: 0,
    stdout: summary + what + "\n",
    stderr: "",
    removed,
    bindingRemoved: edited.removed,
  };
}

/**
 * Ids of every KV namespace on the account. Account-wide by nature, so it has
 * no --remote to pass; it is a "does this id still exist" probe, not a data
 * read.
 *
 * `wrangler kv namespace list` takes no flags at all (wrangler 4.141 rejects
 * `--json` with "Unknown argument") and always logs a JSON array of namespace
 * objects, so there is no alternate shape to accept. Anything that is not that
 * array throws: an unparsable or reshaped probe must read as "unknown", never
 * as "empty", because the caller strips the binding on an empty result.
 */
export function defaultListNamespaceIds(spawn) {
  const result = spawn("npx", ["wrangler", "kv", "namespace", "list"], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "kv namespace list failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error("could not parse `wrangler kv namespace list` output");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("`wrangler kv namespace list` did not return a JSON array");
  }
  const ids = parsed.map((entry) => (typeof entry === "string" ? entry : entry?.id));
  if (ids.some((id) => !id)) {
    throw new Error("`wrangler kv namespace list` returned an entry without an id");
  }
  return ids;
}

/**
 * One page of keys for a namespace, by id.
 *
 * `wrangler kv key list` has no `--cursor` flag in any released version, so
 * this returns the single page wrangler gives (1000 keys) and does not
 * paginate — the migrator's cursor loop in migrate-orders-kv-to-d1.mjs is dead
 * code on the same CLI. Both paths therefore cap at the page limit: a gate run
 * against a namespace holding more than one page of keys would not see the
 * overflow. Live namespaces hold single-digit keys; re-check before running
 * this on a namespace at the page limit.
 */
function defaultListKvKeys(spawn, namespaceId) {
  const result = spawn(
    "npx",
    [
      "wrangler",
      "kv",
      "key",
      "list",
      "--namespace-id",
      namespaceId,
      "--prefix",
      "",
      // --remote is load-bearing for the same reason as in the migration
      // script: without it wrangler reads local storage, which is empty, and
      // an empty KV side would make the gate pass vacuously.
      "--remote",
    ],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "kv key list failed");
  }
  const parsed = JSON.parse(result.stdout || "[]");
  const list = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
  const keys = [];
  for (const entry of list) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (typeof name === "string") keys.push(name);
  }
  return keys;
}

/**
 * One key's value. Only order-keyed keys are ever fetched, so this runs a
 * handful of times, not once per key.
 */
function defaultGetKvValue(spawn, namespaceId, key) {
  const result = spawn(
    "npx",
    ["wrangler", "kv", "key", "get", key, "--namespace-id", namespaceId, "--remote"],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `kv get failed for ${key}`);
  }
  return result.stdout ?? "";
}

/**
 * Every migrated order's session id. Reading the ids rather than a count is
 * what makes the gate checkable per order: a count can only be compared for
 * equality, and equality is not the invariant.
 */
function defaultListD1Sessions(spawn) {
  const result = spawn(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--json",
      "--command",
      "select session_id from orders",
    ],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "d1 read failed");
  }
  return parseD1Sessions(result.stdout);
}

function defaultListD1Tokens(spawn) {
  const result = spawn(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      "--remote",
      "--json",
      "--command",
      "select token from download_tokens",
    ],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "d1 read failed");
  }
  return parseD1Tokens(result.stdout);
}

function defaultDeleteNamespace(spawn, id) {
  const result = spawn(
    "npx",
    ["wrangler", "kv", "namespace", "delete", "--namespace-id", id, "--skip-confirmation"],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `kv namespace delete failed for ${id}`);
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const out = runRemove(process.argv.slice(2));
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr + "\n");
    process.exit(out.exitCode);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
