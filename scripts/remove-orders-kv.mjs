#!/usr/bin/env node
/**
 * Removes the ORDERS KV namespace now that orders live in D1 (#178).
 *
 * The interesting part is not the deletion, it is the gate in front of it. The
 * migration (`npm run migrate:orders`) moved the data once; between then and
 * here the namespace may have received new orders, and a delete that trusts a
 * comment saying "parity verified" is a delete someone runs against a stale
 * claim. So parity is measured live in this process, immediately before
 * anything is touched, and a mismatch refuses:
 *
 *   d1 count(*) from orders  ==  wrangler kv key list --binding ORDERS --remote
 *
 * Both sides are counts of the same logical set — one row per checkout-session
 * key — so equality is the right test. Nothing is deleted and wrangler.toml is
 * not rewritten unless the counts match AND the operator passed `--yes`, so a
 * bare invocation is a no-op rather than an accident.
 *
 * Usage:
 *   npm run orders:kv:remove              # measures parity, refuses unless --yes
 *   npm run orders:kv:remove -- --yes     # removes after the gate passes
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DATABASE_NAME = "nessebar-lens-orders";
export const KV_BINDING = "ORDERS";
export const WRANGLER_TOML = "wrangler.toml";

export function parseArgs(argv) {
  let confirmed = false;
  for (const arg of argv) {
    if (arg === "--yes") confirmed = true;
    else if (arg === "--help" || arg === "-h") return { help: true, confirmed: false };
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { help: false, confirmed };
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
 * Pull the scalar out of a `select count(*) as n …` result, tolerating both
 * wrangler result shapes (bare array, or array with metadata) and refusing to
 * guess: an unparseable count is a failed gate, not a zero.
 */
export function parseCount(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout || "null");
  } catch {
    return null;
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const row = Array.isArray(entry?.results) ? entry.results[0] : null;
  const value = row?.n ?? row?.count ?? row?.c;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

export function runRemove(argv, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const readFile = options.readFileSync ?? ((p) => readFileSync(p, "utf8"));
  const writeFile = options.writeFileSync ?? ((p, data) => writeFileSync(p, data));
  const listKvKeys = options.listKvKeys ?? defaultListKvKeys;
  const countD1Orders = options.countD1Orders ?? defaultCountD1Orders;
  const deleteNamespace = options.deleteNamespace ?? defaultDeleteNamespace;
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
        "Usage: node scripts/remove-orders-kv.mjs [--yes]\n" +
        "\n" +
        "Measures d1 orders vs remote KV keys and refuses to delete unless they match.\n",
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

  let kvKeys;
  let d1Orders;
  try {
    kvKeys = listKvKeys(spawn);
    d1Orders = countD1Orders(spawn);
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  if (d1Orders === null) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "could not read the D1 order count: refusing to delete on an unknown count",
    };
  }

  const summary = `orders:kv:remove gate ${JSON.stringify({ d1Orders, kvKeys: kvKeys.length })}\n`;
  if (kvKeys.length !== d1Orders) {
    return {
      exitCode: 1,
      stdout: summary,
      stderr:
        `parity check failed: D1 has ${d1Orders} orders but KV ${KV_BINDING} holds ${kvKeys.length} keys. ` +
        "Run npm run migrate:orders first, then re-check. Nothing was deleted.",
    };
  }
  if (!parsed.confirmed) {
    return {
      exitCode: 1,
      stdout: summary,
      stderr:
        "parity holds but --yes was not passed: re-run with --yes to remove the namespace. Nothing was deleted.",
    };
  }

  const removed = [];
  for (const id of [binding.id, binding.previewId]) {
    if (!id) continue;
    try {
      deleteNamespace(spawn, id);
      removed.push(id);
    } catch (e) {
      return {
        exitCode: 1,
        stdout: summary,
        stderr:
          `${e instanceof Error ? e.message : String(e)} — ${removed.length} of 2 namespaces deleted so far. ` +
          `${tomlPath} was NOT rewritten; finish the remaining delete by hand.`,
      };
    }
  }

  const edited = removeOrdersKvBinding(toml);
  writeFile(tomlPath, edited.text);
  return {
    exitCode: 0,
    stdout: summary + `removed namespaces ${removed.join(", ")} and the ${KV_BINDING} binding from ${tomlPath}\n`,
    stderr: "",
    removed,
    bindingRemoved: edited.removed,
  };
}

function defaultListKvKeys(spawn) {
  const keys = [];
  let cursor;
  do {
    const args = [
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding",
      KV_BINDING,
      "--prefix",
      "",
      // --remote is load-bearing for the same reason as in the migration
      // script: without it wrangler resolves the binding against local
      // storage, which is empty, and an empty KV side would make the parity
      // check pass vacuously against a non-empty D1 side only if D1 were also
      // empty — the mismatch we rely on would never be seen.
      "--remote",
    ];
    if (cursor) args.push("--cursor", cursor);
    const result = spawn("npx", args, { encoding: "utf8" });
    if ((result.status ?? 1) !== 0) {
      throw new Error(result.stderr || "kv key list failed");
    }
    const parsed = JSON.parse(result.stdout || "[]");
    const list = Array.isArray(parsed) ? parsed : parsed.keys ?? [];
    for (const entry of list) {
      const name = typeof entry === "string" ? entry : entry.name;
      if (typeof name === "string") keys.push(name);
    }
    cursor = Array.isArray(parsed) ? undefined : parsed.cursor;
  } while (cursor);
  return keys;
}

function defaultCountD1Orders(spawn) {
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
      "select count(*) as n from orders",
    ],
    { encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || "d1 count failed");
  }
  return parseCount(result.stdout);
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