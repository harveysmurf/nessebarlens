/**
 * Issue #212: `[env.staging]` bound `MASTERS` to `nessebar-lens-masters`, the
 * production bucket of full-resolution originals. Every PR preview is a version
 * of the staging Worker and runs unreviewed pull_request code, and an R2
 * binding has no read-only mode, so a preview could read, overwrite and delete
 * every production master. Staging now binds its own
 * `nessebar-lens-masters-staging`.
 *
 * This pins the wrangler.toml side of that: staging's masters bucket differs
 * from production's, and NO `[env.*]` section binds a production R2 bucket or
 * the production D1 database. Every env section is checked, so a future
 * `[env.preview]` is covered without editing this file.
 *
 * wrangler.toml is read with a small section/key parser rather than a TOML
 * dependency; the repo has none and the file only uses `[section]`,
 * `[[array]]` and `key = "string"` forms for what is checked here. The floors
 * below keep the parser from going vacuous if the file's shape changes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

const PROD_MASTERS = "nessebar-lens-masters";
const PROD_DB = "nessebar-lens-orders";

type Binding = {
  /** e.g. "r2_buckets" or "env.staging.d1_databases" */
  section: string;
  /** "" for the top level, else the env name ("staging"). */
  env: string;
  kind: string;
  binding: string;
  /** bucket_name for r2_buckets, database_name for d1_databases. */
  resource: string;
};

/** Every `[[r2_buckets]]` / `[[d1_databases]]` entry, tagged with its env. */
function parseBindings(toml: string): Binding[] {
  const found: Binding[] = [];
  let current: { section: string; fields: Record<string, string> } | null = null;
  const flush = () => {
    if (!current) return;
    const m = current.section.match(/^(?:env\.([\w-]+)\.)?(r2_buckets|d1_databases)$/);
    if (m) {
      const kind = m[2];
      found.push({
        section: current.section,
        env: m[1] ?? "",
        kind,
        binding: current.fields.binding ?? "",
        resource:
          (kind === "r2_buckets"
            ? current.fields.bucket_name
            : current.fields.database_name) ?? "",
      });
    }
    current = null;
  };
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const head = line.match(/^\[{1,2}([^\]]+)\]{1,2}$/);
    if (head) {
      flush();
      current = { section: head[1].trim(), fields: {} };
      continue;
    }
    const kv = line.match(/^(\w+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    if (kv && current) current.fields[kv[1]] = kv[2];
  }
  flush();
  return found;
}

/** Violations of the #212 rules; empty when the config is isolated. */
function bindingViolations(bindings: Binding[]): string[] {
  const problems: string[] = [];
  for (const b of bindings) {
    if (b.env === "") continue;
    if (b.kind === "r2_buckets" && b.resource === PROD_MASTERS) {
      problems.push(`env.${b.env} ${b.binding} binds the production masters bucket ${PROD_MASTERS}`);
    }
    if (b.kind === "d1_databases" && b.resource === PROD_DB) {
      problems.push(`env.${b.env} ${b.binding} binds the production database ${PROD_DB}`);
    }
  }
  const top = bindings.find((b) => b.env === "" && b.binding === "MASTERS");
  for (const b of bindings.filter((x) => x.env !== "" && x.binding === "MASTERS")) {
    if (b.resource === top?.resource) {
      problems.push(`env.${b.env} MASTERS equals the top-level bucket`);
    }
    if (!b.resource.endsWith("-staging")) {
      problems.push(`env.${b.env} MASTERS bucket ${b.resource} does not end in -staging`);
    }
  }
  return problems;
}

const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const bindings = parseBindings(toml);
const masters = bindings.filter((b) => b.binding === "MASTERS");

test("the parser reads wrangler.toml's bindings, so the guards below cannot be vacuous", () => {
  assert.ok(masters.length >= 2, `found ${masters.length} MASTERS bindings, expected top-level + staging`);
  assert.ok(bindings.length >= 6, `found ${bindings.length} bindings, expected at least 6`);
  assert.ok(
    bindings.some((b) => b.env === "staging" && b.kind === "d1_databases"),
    "staging's D1 binding is no longer visible to the parser",
  );
  assert.ok(bindings.some((b) => b.env === "" && b.kind === "d1_databases"));
});

test("production's MASTERS is nessebar-lens-masters", () => {
  const top = masters.find((b) => b.env === "");
  assert.equal(top?.resource, PROD_MASTERS);
});

test("staging's MASTERS is a distinct bucket ending in -staging", () => {
  const top = masters.find((b) => b.env === "")!;
  const staging = masters.find((b) => b.env === "staging");
  assert.ok(staging, "[env.staging] has no MASTERS binding");
  assert.notEqual(staging.resource, top.resource);
  assert.ok(staging.resource.endsWith("-staging"), staging.resource);
});

test("no [env.*] binds the production masters bucket or orders database", () => {
  assert.deepEqual(bindingViolations(bindings), []);
});

test("negative control: a staging block pointing at the production bucket is rejected", () => {
  const bad = `
[[r2_buckets]]
binding = "MASTERS"
bucket_name = "nessebar-lens-masters"

[[env.staging.r2_buckets]]
binding = "MASTERS"
bucket_name = "nessebar-lens-masters"

[[env.preview.d1_databases]]
binding = "ORDERS_DB"
database_name = "nessebar-lens-orders"
`;
  const problems = bindingViolations(parseBindings(bad));
  assert.ok(problems.some((p) => /env\.staging MASTERS binds the production masters/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /equals the top-level/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /env\.preview .*production database/.test(p)), problems.join("\n"));
});
